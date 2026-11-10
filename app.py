import math
import requests
from flask import Flask, render_template, request, jsonify
from datetime import datetime, timezone

app = Flask(__name__)

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

if __name__ == "__main__":
    app.run(debug=True)