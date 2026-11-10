
import os
from dotenv import load_dotenv
from mistralai.client import Mistral

load_dotenv()

client = Mistral(
    api_key=os.getenv("MISTRAL_API_KEY"),
    server="eu"
)

response = client.chat.complete(
    model="mistral-small-latest",
    messages=[
        {
            "role": "system",
            "content": "You are a helpful AI road trip assistant."
        },
        {
            "role": "user",
            "content": """
            I am planning a 450 km road trip in Sweden.
            The weather forecast shows:
            - Temperature: 3°C
            - Rain probability: 80%
            - Wind: 35 km/h

            Give me three short driving recommendations.
            """
        }
    ]
)

print("\nMISTRAL AI RESPONSE:\n")
print(response.choices[0].message.content)
