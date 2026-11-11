import math
import requests
from flask import Flask, render_template, request, jsonify
from datetime import datetime, timezone
import os
from dotenv import load_dotenv
from mistralai.client import Mistral
import json
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
import sqlite3
from datetime import datetime, timezone

app = Flask(__name__)

# Request size protection
app.config["MAX_CONTENT_LENGTH"] = 2 * 1024 * 1024
# Rate limiter
limiter = Limiter(
    get_remote_address,
    app=app,
    default_limits=[]
)
# ====================================
# DAILY MISTRAL USAGE BUDGET
# ====================================

DATABASE = "usage.db"
DAILY_TOKEN_LIMIT = 50000
MAX_AI_RESPONSE_TOKENS = 500

def init_usage_database():
    with sqlite3.connect(DATABASE) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS daily_usage (
                usage_date TEXT PRIMARY KEY,
                used_tokens INTEGER NOT NULL DEFAULT 0,
                reserved_tokens INTEGER NOT NULL DEFAULT 0
            )
        """)


init_usage_database()

def reserve_daily_budget(messages, max_output_tokens):
    # Estimate input size conservatively using characters.
    input_estimate = len(
        json.dumps(messages, ensure_ascii=False)
    )

    estimated_tokens = input_estimate + max_output_tokens
    today = datetime.now(timezone.utc).date().isoformat()

    with sqlite3.connect(DATABASE, timeout=10) as conn:
        conn.execute("BEGIN IMMEDIATE")

        conn.execute("""
            INSERT OR IGNORE INTO daily_usage (usage_date)
            VALUES (?)
        """, (today,))

        row = conn.execute("""
            SELECT used_tokens, reserved_tokens
            FROM daily_usage
            WHERE usage_date = ?
        """, (today,)).fetchone()

        used_tokens, reserved_tokens = row

        if used_tokens + reserved_tokens + estimated_tokens > DAILY_TOKEN_LIMIT:
            return None

        conn.execute("""
            UPDATE daily_usage
            SET reserved_tokens = reserved_tokens + ?
            WHERE usage_date = ?
        """, (estimated_tokens, today))

    return estimated_tokens


def finish_daily_budget(reserved_tokens, actual_tokens):
    today = datetime.now(timezone.utc).date().isoformat()

    with sqlite3.connect(DATABASE, timeout=10) as conn:
        conn.execute("""
            UPDATE daily_usage
            SET reserved_tokens = MAX(0, reserved_tokens - ?),
                used_tokens = used_tokens + ?
            WHERE usage_date = ?
        """, (reserved_tokens, actual_tokens, today))


def release_daily_budget(reserved_tokens):
    today = datetime.now(timezone.utc).date().isoformat()

    with sqlite3.connect(DATABASE, timeout=10) as conn:
        conn.execute("""
            UPDATE daily_usage
            SET reserved_tokens = MAX(0, reserved_tokens - ?)
            WHERE usage_date = ?
        """, (reserved_tokens, today))

# ====================================
# MISTRAL AI CONFIGURATION
# ====================================

load_dotenv()

mistral_api_key = os.getenv("MISTRAL_API_KEY")

if not mistral_api_key:
    raise RuntimeError("MISTRAL_API_KEY is missing from .env")

mistral_client = Mistral(
    api_key=mistral_api_key,
    server="eu"
)

#route 
@app.route("/")
def home():
    return render_template("index.html")

#geocodes for API
@app.route("/geocode")
def geocode():
    place = request.args.get("q", "").strip()

    if not place:
        return jsonify({"error": "Please enter a location"}), 400

    url = "https://nominatim.openstreetmap.org/search"

    params = {
        "q": place,
        "format": "jsonv2",
        "limit": min(int(request.args.get("limit", 1)), 5)
    }

    headers = {
        "User-Agent": "WeatherRoutePlanner/1.0"
    }

    try:
        response = requests.get(
            url,
            params=params,
            headers=headers,
            timeout=10
        )

        response.raise_for_status()
        results = response.json()

        if not results:
            return jsonify({"error": "Location not found"}), 404

        locations = [
            {
                "name": result["display_name"],
                "lat": float(result["lat"]),
                "lon": float(result["lon"])
            }
            for result in results
        ]

        return jsonify(locations)

    except requests.RequestException:
        return jsonify({"error": "Could not contact the geocoding service"}), 502

#route on a map
@app.route("/route")
def get_route():
    start_lat = request.args.get("start_lat")
    start_lon = request.args.get("start_lon")
    end_lat = request.args.get("end_lat")
    end_lon = request.args.get("end_lon")

    if not all([start_lat, start_lon, end_lat, end_lon]):
        return jsonify({"error": "Missing coordinates"}), 400

    # OSRM expects longitude,latitude
    coordinates = (
        f"{start_lon},{start_lat};{end_lon},{end_lat}"
    )

    url = f"https://router.project-osrm.org/route/v1/driving/{coordinates}"

    params = {
        "overview": "full",
        "geometries": "geojson"
    }

    try:
        response = requests.get(url, params=params, timeout=15)
        response.raise_for_status()

        data = response.json()

        if data["code"] != "Ok" or not data["routes"]:
            return jsonify({"error": "Could not calculate route"}), 400

        route = data["routes"][0]

        return jsonify({
            "geometry": route["geometry"],
            "distance": route["distance"],
            "duration": route["duration"]
        })

    except requests.RequestException:
        return jsonify({"error": "Could not contact the routing service"}), 502

#collecting distances
def haversine_distance(point1, point2):
    """Calculate distance in kilometres between two [lon, lat] points."""
    lon1, lat1 = point1
    lon2, lat2 = point2

    radius = 6371

    lat1 = math.radians(lat1)
    lat2 = math.radians(lat2)
    delta_lat = math.radians(lat2 - lat1)
    delta_lon = math.radians(lon2 - lon1)

    a = (
        math.sin(delta_lat / 2) ** 2
        + math.cos(lat1) * math.cos(lat2)
        * math.sin(delta_lon / 2) ** 2
    )

    return radius * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

#collecting coordinates
def sample_route(coordinates, interval_km=30):
    """Select route points at regular intervals and retain road distance."""

    if not coordinates:
        return []

    # Calculate cumulative distance along the complete route
    cumulative_distances = [0.0]

    for i in range(1, len(coordinates)):
        segment_distance = haversine_distance(
            coordinates[i - 1],
            coordinates[i]
        )

        cumulative_distances.append(
            cumulative_distances[-1] + segment_distance
        )

    total_distance = cumulative_distances[-1]

    if total_distance == 0:
        return [{
            "coordinate": coordinates[0],
            "distance_km": 0.0
        }]

    # Generate target distances: 0, 30, 60, 90, etc.
    targets = list(range(0, int(total_distance), interval_km))

    if not targets or targets[0] != 0:
        targets.insert(0, 0)

    targets.append(total_distance)

    sampled_points = []
    segment_index = 0

    for target in targets:

        # Find the route segment containing this target distance
        while (
            segment_index < len(cumulative_distances) - 2
            and cumulative_distances[segment_index + 1] < target
        ):
            segment_index += 1

        start_distance = cumulative_distances[segment_index]
        end_distance = cumulative_distances[segment_index + 1]

        start_coordinate = coordinates[segment_index]
        end_coordinate = coordinates[segment_index + 1]

        segment_length = end_distance - start_distance

        if segment_length == 0:
            fraction = 0
        else:
            fraction = (
                (target - start_distance) / segment_length
            )

        # Interpolate the GPS coordinate along this route segment
        longitude = (
            start_coordinate[0]
            + fraction * (end_coordinate[0] - start_coordinate[0])
        )

        latitude = (
            start_coordinate[1]
            + fraction * (end_coordinate[1] - start_coordinate[1])
        )

        sampled_points.append({
            "coordinate": [longitude, latitude],
            "distance_km": round(target, 1)
        })

    return sampled_points


#for weather forecasts
@app.route("/weather", methods=["POST"])
def get_weather():
    data = request.get_json()
    
    coordinates = data.get("coordinates")
    departure_time = data.get("departure")
    duration = data.get("duration")
    route_distance_km = data.get("route_distance_km")

    if not coordinates or not departure_time or duration is None or route_distance_km is None:
        return jsonify({"error": "Missing route or departure information"}), 400

    try:
        departure = datetime.fromisoformat(
            departure_time.replace("Z", "+00:00")
        )

        if departure.tzinfo is None:
            return jsonify({"error": "Departure time must include a timezone"}), 400

        departure = departure.astimezone(timezone.utc)

        route_points = sample_route(coordinates)

        # Estimate arrival time at each sampled point.
        total_distance = sum(
            haversine_distance(coordinates[i - 1], coordinates[i])
            for i in range(1, len(coordinates))
        )

        if total_distance == 0:
            return jsonify({"error": "Route has no measurable distance"}), 400

        latitudes = ",".join(
            str(point["coordinate"][1])
            for point in route_points
        )
        longitudes = ",".join(
            str(point["coordinate"][0])
            for point in route_points
        )

        weather_url = "https://api.open-meteo.com/v1/forecast"

        params = {
            "latitude": latitudes,
            "longitude": longitudes,
            "hourly": (
                "temperature_2m,"
                "precipitation_probability,"
                "precipitation,"
                "snowfall"
            ),
            "forecast_days": 16,
            "timezone": "UTC"
        }

        response = requests.get(weather_url, params=params, timeout=20)
        response.raise_for_status()

        weather_data = response.json()

        # Open-Meteo returns a list when multiple locations are requested.
        if isinstance(weather_data, dict):
            weather_data = [weather_data]

        
        results = []

        for i, point in enumerate(route_points):

            # Progress along the route, based on route geometry
            progress = point["distance_km"] / total_distance

            # Scale geometry distance to OSRM's actual route distance
            distance_along_route = progress * route_distance_km

            # Estimate arrival time based on route progress
            estimated_arrival = departure.timestamp() + duration * progress

            location_weather = weather_data[i]
            hourly = location_weather["hourly"]
            times = hourly["time"]

            target_time = datetime.fromtimestamp(
                estimated_arrival,
                tz=timezone.utc
            ).replace(tzinfo=None)

            # Find the closest forecast hour
            closest_index = min(
                range(len(times)),
                key=lambda index: abs(
                    datetime.fromisoformat(times[index]) - target_time
                )
            )

            coordinate = point["coordinate"]

            results.append({
                "latitude": coordinate[1],
                "longitude": coordinate[0],
                "distance_km": round(distance_along_route, 1),
                "arrival": datetime.fromtimestamp(
                    estimated_arrival,
                    tz=timezone.utc
                ).isoformat(),
                "temperature": hourly["temperature_2m"][closest_index],
                "rain_probability": hourly["precipitation_probability"][closest_index],
                "precipitation": hourly["precipitation"][closest_index],
                "snowfall": hourly["snowfall"][closest_index]
            })


        return jsonify({"forecasts": results})

    except requests.RequestException as error:
        return jsonify({"error": f"Weather service error: {error}"}), 502

    except (ValueError, KeyError, TypeError, IndexError) as error:
        return jsonify({"error": f"Could not process weather data: {error}"}), 400


# =====================================
# PLACES ALONG THE ROUTE
# =====================================

def select_places_search_points(coordinates, spacing_km=5, max_points=100):
    """
    Select points approximately every 5 km along the route.
    Coordinates must be [longitude, latitude].
    """

    if not coordinates:
        return []

    def distance_km(point1, point2):
        from math import radians, sin, cos, sqrt, atan2

        lon1, lat1 = point1
        lon2, lat2 = point2

        lat1 = radians(lat1)
        lat2 = radians(lat2)
        dlat = lat2 - lat1
        dlon = radians(lon2 - lon1)

        a = (
            sin(dlat / 2) ** 2
            + cos(lat1) * cos(lat2) * sin(dlon / 2) ** 2
        )

        return 6371 * 2 * atan2(sqrt(a), sqrt(1 - a))

    selected = [coordinates[0]]
    distance_since_last = 0

    for index in range(1, len(coordinates)):
        distance_since_last += distance_km(
            coordinates[index - 1],
            coordinates[index]
        )

        if distance_since_last >= spacing_km:
            selected.append(coordinates[index])
            distance_since_last = 0

    if selected[-1] != coordinates[-1]:
        selected.append(coordinates[-1])

    # Limit the number of search points for very long routes
    if len(selected) > max_points:
        step = (len(selected) - 1) / (max_points - 1)

        selected = [
            selected[round(i * step)]
            for i in range(max_points)
        ]

    return selected
def distance_to_route_m(place_lon, place_lat, coordinates):
    """
    Calculate approximate shortest distance in metres
    between a place and a route polyline.
    """

    from math import radians, cos, sqrt

    earth_radius = 6371000

    min_distance = float("inf")

    for index in range(len(coordinates) - 1):

        lon1, lat1 = coordinates[index]
        lon2, lat2 = coordinates[index + 1]

        # Convert coordinates to local metre-based coordinates
        reference_lat = radians(place_lat)

        x1 = radians(lon1 - place_lon) * earth_radius * cos(reference_lat)
        y1 = radians(lat1 - place_lat) * earth_radius

        x2 = radians(lon2 - place_lon) * earth_radius * cos(reference_lat)
        y2 = radians(lat2 - place_lat) * earth_radius

        dx = x2 - x1
        dy = y2 - y1

        segment_length_squared = dx * dx + dy * dy

        if segment_length_squared == 0:
            t = 0
        else:
            t = -(x1 * dx + y1 * dy) / segment_length_squared
            t = max(0, min(1, t))

        closest_x = x1 + t * dx
        closest_y = y1 + t * dy

        distance = sqrt(closest_x ** 2 + closest_y ** 2)

        min_distance = min(min_distance, distance)

    return min_distance


def get_place_coordinates(element):
    """Get coordinates from an OSM node, way or relation."""

    if "lat" in element and "lon" in element:
        return element["lat"], element["lon"]

    center = element.get("center")

    if center:
        return center["lat"], center["lon"]

    return None, None


# ====================================
# MISTRAL AI - TRAVEL REPORT
# ====================================

@app.route("/ai/travel-report", methods=["POST"])
def generate_travel_report():

    data = request.get_json(silent=True) or {}

    route = data.get("route")
    weather = data.get("weather")
    fuel = data.get("fuel")

    # Validate incoming data
    if not isinstance(route, dict):
        return jsonify({"error": "Route information is required"}), 400

    if not isinstance(weather, list) or not weather:
        return jsonify({"error": "Weather information is required"}), 400

    if not isinstance(fuel, dict):
        return jsonify({"error": "Fuel information is required"}), 400

    # Limit payload size
    if len(weather) > 200:
        return jsonify({"error": "Too many weather forecast points"}), 400

    travel_data = {
        "route": route,
        "weather": weather,
        "fuel": fuel
    }

    system_prompt = """
    You are an AI road trip planning assistant.

    Analyse the supplied route, weather and fuel information.

    Rules:
    - Use only the supplied information.
    - Never invent weather conditions or route information.
    - Do not repeat fuel distance, consumption, estimated litres or fuel cost.
    - Do not repeat numerical fuel calculations.
    - The frontend already displays the fuel calculation.
    - Use the fuel information only when it adds useful context to the overall journey analysis.
    - Explain potential weather risks along the route.
    - Give practical driving recommendations.
    - Never recommend changing to winter tyres based only on temperature.
    - Do not make assumptions about current tyre type or tread depth.
    - Distinguish general cold-weather advice from legal tyre requirements.
    - Do not state legal requirements unless verified using an authoritative source.
    - If tyre information is unavailable, say that the user should check their tyres and the applicable local regulations.
    - Do not make legal guarantees.
    - Do not invent fuel prices or vehicle specifications.
    - If information is missing, state that clearly.
    - Do not assume rain means snow or ice.
    - Do not claim that roads are slippery unless the data supports it.

    Return a JSON object with these exact fields:

    {
        "risk_level": "Low, Moderate or High",
        "overall_summary": "Short journey summary",
        "weather_analysis": "Weather conditions and potential risks",
        "tyre_recommendations": "Practical tyre advice",
        "fuel_summary": "Optional additional fuel-related advice without repeating numerical estimates",
        "travel_tips": ["Tip 1", "Tip 2", "Tip 3"]
    }

    The risk level should reflect the supplied weather information.
    """

    # 1. Create messages FIRST
    messages = [
        {
            "role": "system",
            "content": system_prompt
        },
        {
            "role": "user",
            "content": json.dumps(travel_data, ensure_ascii=False)
        }
    ]

    # 2. Check and reserve daily AI budget
    reserved_tokens = reserve_daily_budget(
        messages,
        MAX_AI_RESPONSE_TOKENS
    )

    if reserved_tokens is None:
        return jsonify({
            "success": False,
            "error": "The daily AI usage budget has been reached. Please try again tomorrow."
        }), 429

    # 3. Call Mistral
    try:
        response = mistral_client.chat.complete(
            model="mistral-small-latest",
            messages=messages,
            response_format={"type": "json_object"},
            temperature=0.3,
            max_tokens=MAX_AI_RESPONSE_TOKENS
        )

    except Exception as error:
        release_daily_budget(reserved_tokens)

        print("Mistral travel report error:", error)

        return jsonify({
            "success": False,
            "error": "Could not generate the travel report. Please try again."
        }), 502

    # 4. Record actual token usage
    actual_tokens = response.usage.total_tokens

    finish_daily_budget(
        reserved_tokens,
        actual_tokens
    )

    # 5. Process Mistral response
    try:
        report_content = response.choices[0].message.content

        report = json.loads(report_content)

        required_fields = [
            "risk_level",
            "overall_summary",
            "weather_analysis",
            "tyre_recommendations",
            "fuel_summary",
            "travel_tips"
        ]

        if not isinstance(report, dict) or not all(
            field in report for field in required_fields
        ):
            raise ValueError("Invalid report structure returned by Mistral")

        if report["risk_level"] not in ["Low", "Moderate", "High"]:
            raise ValueError("Invalid risk level returned by Mistral")

        return jsonify({
            "success": True,
            "report": report
        })

    except Exception as error:
        print("Travel report processing error:", error)

        return jsonify({
            "error": "Could not process the travel report. Please try again."
        }), 502


# ====================================
# MISTRAL AI - ROAD TRIP CHAT
# ====================================

@app.route("/ai/chat", methods=["POST"])
@limiter.limit("10 per minute")
@limiter.limit("100 per day")
def ai_chat():

    data = request.get_json(silent=True) or {}

    message = data.get("message")
    history = data.get("history", [])
    context = data.get("context", {})

    # Validate user message
    if not isinstance(message, str) or not message.strip():
        return jsonify({"error": "A message is required"}), 400

    message = message.strip()

    if len(message) > 1000:
        return jsonify({"error": "Message is too long"}), 400

    # Validate conversation history
    if not isinstance(history, list):
        return jsonify({"error": "Invalid conversation history"}), 400

    if len(history) > 20:
        return jsonify({"error": "Conversation history is too long"}), 400

    for item in history:
        if (
            not isinstance(item, dict)
            or item.get("role") not in ["user", "assistant"]
            or not isinstance(item.get("content"), str)
            or len(item["content"]) > 4000
        ):
            return jsonify({"error": "Invalid conversation message"}), 400

    # Validate journey context
    if not isinstance(context, dict):
        return jsonify({"error": "Invalid journey context"}), 400

    route = context.get("route")
    weather = context.get("weather")
    fuel = context.get("fuel")

    if not all([
        isinstance(route, dict),
        isinstance(weather, list),
        isinstance(fuel, dict)
    ]):
        return jsonify({"error": "Incomplete journey information"}), 400

    if len(weather) > 200:
        return jsonify({"error": "Too many weather forecast points"}), 400

    system_prompt = """
    You are an AI Road Trip Assistant.

    Help the user with questions about their current journey.

    You receive information about:
    - Route distance and driving duration
    - Departure and estimated arrival
    - Weather forecasts along the route
    - Fuel consumption and estimated fuel cost

    IMPORTANT RULES:

    1. Use the supplied journey information.
    2. Never invent weather conditions or route information.
    3. Do not invent places, petrol stations or sightseeing locations.
    4. Do not change or recalculate the supplied fuel estimates.
    5. Never recommend winter tyres based only on temperature.
    6. Do not make legal guarantees about tyre requirements.
    7. Clearly state when information is unavailable.
    8. Distinguish forecast information from confirmed conditions.
    9. Be helpful, concise and practical.
    10. If the user asks something unrelated to travel,
        politely explain that you are a road trip assistant.
    """

    
    try:
        journey_context = {
            "route": route,
            "weather": weather,
            "fuel": fuel
        }

        messages = [
            {
                "role": "system",
                "content": system_prompt
            },
            {
                "role": "system",
                "content": (
                    "Current journey information:\n"
                    + json.dumps(journey_context, ensure_ascii=False)
                )
            }
        ]

        messages.extend(history)

        messages.append({
            "role": "user",
            "content": message
        })

        # Reserve daily AI budget
        reserved_tokens = reserve_daily_budget(
            messages,
            MAX_AI_RESPONSE_TOKENS
        )

        if reserved_tokens is None:
            return jsonify({
                "success": False,
                "error": "The daily AI usage budget has been reached. Please try again tomorrow."
            }), 429

        # Call Mistral
        try:
            response = mistral_client.chat.complete(
                model="mistral-small-latest",
                messages=messages,
                temperature=0.3,
                max_tokens=MAX_AI_RESPONSE_TOKENS
            )

        except Exception as error:
            release_daily_budget(reserved_tokens)

            print("Mistral chat error:", error)

            return jsonify({
                "success": False,
                "error": "Could not generate an AI response. Please try again."
            }), 502

        # Record actual token usage
        actual_tokens = response.usage.total_tokens

        finish_daily_budget(
            reserved_tokens,
            actual_tokens
        )

        # Extract AI response
        answer = response.choices[0].message.content

        if not isinstance(answer, str) or not answer.strip():
            return jsonify({
                "success": False,
                "error": "Mistral returned an empty response."
            }), 502

        return jsonify({
            "success": True,
            "answer": answer
        })

    except Exception as error:

        print("Mistral chat error:", error)

        return jsonify({
            "success": False,
            "error": "Could not generate an AI response. Please try again."
        }), 502

# ====================================
# RATE LIMIT ERROR HANDLER
# ====================================

@app.errorhandler(429)
def ratelimit_handler(error):
    return jsonify({
        "success": False,
        "error": "Too many requests. Please wait before trying again."
    }), 429
@app.errorhandler(413)
def request_too_large(error):
    return jsonify({
        "success": False,
        "error": "Request is too large."
    }), 413
if __name__ == "__main__":
    app.run(debug=False)