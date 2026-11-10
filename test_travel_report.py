
import requests
import json

url = "http://127.0.0.1:5000/ai/travel-report"

test_data = {
    "route": {
        "distance_km": 450,
        "driving_time": "5 hours",
        "departure": "09:00",
        "arrival": "14:00"
    },
    "weather": [
        {
            "arrival": "10:00",
            "distance_km": 100,
            "temperature": 3,
            "rain_probability": 80,
            "precipitation": 2,
            "snowfall": 0
        },
        {
            "arrival": "12:00",
            "distance_km": 250,
            "temperature": 5,
            "rain_probability": 60,
            "precipitation": 1,
            "snowfall": 0
        }
    ],
    "fuel": {
        "vehicle": "Medium",
        "consumption": 7.0,
        "fuel_type": "Petrol",
        "fuel_price": 18,
        "estimated_litres": 31.5,
        "estimated_cost": 567
    }
}

response = requests.post(url, json=test_data, timeout=90)

print("HTTP status:", response.status_code)

result = response.json()

print(json.dumps(result, indent=4, ensure_ascii=False))
