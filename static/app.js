
const map = L.map("map").setView([59.3293, 18.0686], 6);

L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors"
}).addTo(map);

const routeForm = document.getElementById("route-form");
const statusMessage = document.getElementById("status");

let startMarker = null;
let destinationMarker = null;
let routeLayer = null;
let weatherMarkers = [];
let lastWeatherForecasts = [];
let lastRoute = null;
let lastDeparture = null;
// Store the latest calculated route distance
let lastRouteDistanceKm = null;
let chatHistory = [];
let isChatLoading = false;

// ====================================
// FIND LOCATION
// ====================================

async function findLocation(place) {
    const response = await fetch(
        `/geocode?q=${encodeURIComponent(place)}`
    );

    const data = await response.json();

    if (!response.ok || !data.length) {
        throw new Error("Location not found");
    }

    return data[0];
}


// ====================================
// CALCULATE ROUTE
// ====================================

async function calculateRoute(start, destination) {
    const params = new URLSearchParams({
        start_lat: start.lat,
        start_lon: start.lon,
        end_lat: destination.lat,
        end_lon: destination.lon
    });

    const response = await fetch(`/route?${params}`);
    const data = await response.json();

    if (!response.ok) {
        throw new Error(data.error || "Could not calculate route");
    }

    return data;
}


// ====================================
// GET WEATHER FORECAST
// ====================================

async function getWeather(route, departure) {
    const response = await fetch("/weather", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            coordinates: route.geometry.coordinates,
            departure: departure.toISOString(),
            duration: route.duration,
            route_distance_km: route.distance / 1000
        })
    });

    const data = await response.json();

    if (!response.ok) {
        throw new Error(
            data.error || "Could not retrieve weather forecast"
        );
    }

    return data.forecasts;
}

// ====================================
// MARKERS
// ====================================


function displayWeatherMarkers(forecasts) {

    // Remove previous weather markers
    weatherMarkers.forEach(marker => {
        map.removeLayer(marker);
    });

    weatherMarkers = [];

    forecasts.forEach(point => {

        // Select weather icon
        let weatherIcon = "☀️";

        if (point.snowfall > 0) {
            weatherIcon = "❄️";
        } else if (
            point.rain_probability >= 30 ||
            point.precipitation > 0
        ) {
            weatherIcon = "🌧️";
        }

        // Format temperature
        const temperature = point.temperature !== null &&
            point.temperature !== undefined
            ? `${Number(point.temperature).toFixed(1)}°C`
            : "N/A";

        // Create custom icon with temperature label
        const icon = L.divIcon({
            className: "weather-map-icon",
            html: `
                <div class="weather-marker-wrapper">
                    <div class="weather-icon-circle">
                        ${weatherIcon}
                    </div>
                    <div class="weather-temperature-label">
                        ${temperature}
                    </div>
                </div>
            `,
            iconSize: [70, 58],
            iconAnchor: [35, 29]
        });

        // Create marker
        const marker = L.marker(
            [point.latitude, point.longitude],
            { icon: icon }
        ).addTo(map);

        // Format arrival time
        const arrival = new Date(point.arrival);

        // Create popup
        marker.bindPopup(`
            <div class="weather-popup">
                <h3>${weatherIcon} Weather forecast</h3>

                <p><strong>Distance:</strong>
                    ${Number(point.distance_km).toFixed(1)} km from start
                </p>

                <p><strong>Arrival:</strong>
                    ${arrival.toLocaleString()}
                </p>

                <p><strong>Temperature:</strong>
                    ${temperature}
                </p>

                <p><strong>Rain probability:</strong>
                    ${point.rain_probability ?? "N/A"}%
                </p>

                <p><strong>Precipitation:</strong>
                    ${point.precipitation ?? "N/A"} mm
                </p>

                <p><strong>Snowfall:</strong>
                    ${point.snowfall ?? "N/A"} cm
                </p>
            </div>
        `);

        weatherMarkers.push(marker);
    });
}

// ====================================
// MAIN ROUTE FORM
// ====================================

routeForm.addEventListener("submit", async function (event) {
    event.preventDefault();
    document.getElementById("generate-ai-report").disabled = true;
    document.getElementById("ai-chat-input").disabled = true;
    document.getElementById("ai-chat-send").disabled = true;

    chatHistory = [];

    document.getElementById("ai-chat-messages").innerHTML = "";

    addChatMessage(
        "Your new journey is being calculated. Ask me anything about it when the route is ready!",
        "assistant"
    );
    // Get input values
    const start = document.getElementById("start").value.trim();
    const destination = document.getElementById("destination").value.trim();

    const departureDate = document.getElementById("departure").value;
    const departureTime = document.getElementById("departure-time").value;

    const departure = new Date(`${departureDate}T${departureTime}`);

    // Validate departure date and time

    if (isNaN(departure.getTime())) {
        statusMessage.textContent =
            "Please select a valid departure date and time.";
        return;
    }

    if (!start || !destination) {
        statusMessage.textContent =
            "Please enter both start and destination.";
        return;
    }

    statusMessage.textContent = "Searching for locations...";

    const weatherContainer = document.getElementById("weather-results");

    if (weatherContainer) {
        weatherContainer.innerHTML = "";
    }

    try {
        // Find start location

        const startLocation = await findLocation(start);

        // Wait before the next geocoding request

        await new Promise(resolve => setTimeout(resolve, 1100));

        // Find destination location

        const destinationLocation = await findLocation(destination);

        statusMessage.textContent = "Calculating route...";

        // Calculate driving route

        const route = await calculateRoute(
            startLocation,
            destinationLocation
        );
        lastRoute = route;
        lastDeparture = departure;

        // Update fuel estimate using actual OSRM route distance
        lastRouteDistanceKm = route.distance / 1000;

        updateFuelEstimate(lastRouteDistanceKm);

        // ====================================
        // UPDATE MAP
        // ====================================

        // Remove previous route and markers

        if (startMarker) {
            map.removeLayer(startMarker);
        }

        if (destinationMarker) {
            map.removeLayer(destinationMarker);
        }

        if (routeLayer) {
            map.removeLayer(routeLayer);
        }

        // Create start marker

        startMarker = L.marker([
            startLocation.lat,
            startLocation.lon
        ]).addTo(map);

        startMarker.bindPopup("Start: " + startLocation.name);

        // Create destination marker

        destinationMarker = L.marker([
            destinationLocation.lat,
            destinationLocation.lon
        ]).addTo(map);

        destinationMarker.bindPopup(
            "Destination: " + destinationLocation.name
        );

        // Draw driving route

        routeLayer = L.geoJSON(route.geometry, {
            style: {
                color: "#2563eb",
                weight: 5,
                opacity: 0.8
            }
        }).addTo(map);

        // Zoom to entire route

        map.fitBounds(routeLayer.getBounds(), {
            padding: [50, 50]
        });


        // ====================================
        // CALCULATE ROUTE INFORMATION
        // ====================================

        const distanceKm = (route.distance / 1000).toFixed(1);

        const durationHours = Math.floor(route.duration / 3600);

        const durationMinutes = Math.round(
            (route.duration % 3600) / 60
        );

        // Calculate estimated arrival time

        const arrival = new Date(
            departure.getTime() + route.duration * 1000
        );

        const arrivalTime = arrival.toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit"
        });

        const arrivalDate = arrival.toLocaleDateString();

        statusMessage.textContent =
            `Distance: ${distanceKm} km | ` +
            `Driving time: ${durationHours}h ${durationMinutes}m | ` +
            `Arrival: ${arrivalDate} ${arrivalTime}`;


        // ====================================
        // GET AND DISPLAY WEATHER
        // ====================================

        statusMessage.textContent += " | Loading weather...";

        const forecasts = await getWeather(route, departure);

        lastWeatherForecasts = forecasts;

        displayWeatherMarkers(forecasts);

        // Enable AI chatbot after route and weather are ready
        document.getElementById("ai-chat-input").disabled = false;
        document.getElementById("ai-chat-send").disabled = false;

        document.getElementById("ai-chat-status").textContent =
            "Your journey is ready. Ask me anything!";
        
        document.getElementById("generate-ai-report").disabled = false;

        document.getElementById("ai-report-status").textContent =
            "Your route is ready. Generate your AI travel report.";

        statusMessage.textContent =
            `Distance: ${distanceKm} km | ` +
            `Driving time: ${durationHours}h ${durationMinutes}m | ` +
            `Arrival: ${arrivalDate} ${arrivalTime} | ` +
            `Weather loaded`;
        routePanel.classList.add("hidden");
        showPanelButton.hidden = false;
    } catch (error) {
        statusMessage.textContent = error.message;
        console.error(error);
    }
});


// ====================================
// AUTOCOMPLETE
// ====================================

function setupAutocomplete(inputId, suggestionsId) {
    const input = document.getElementById(inputId);
    const suggestions = document.getElementById(suggestionsId);

    let timeout = null;

    input.addEventListener("input", function () {
        clearTimeout(timeout);

        const query = input.value.trim();

        suggestions.innerHTML = "";

        if (query.length < 3) {
            return;
        }

        timeout = setTimeout(async function () {
            try {
                const response = await fetch(
                    `/geocode?q=${encodeURIComponent(query)}&limit=5`
                );

                const data = await response.json();

                if (!response.ok) {
                    return;
                }

                suggestions.innerHTML = "";

                data.forEach(function (place) {
                    const item = document.createElement("div");

                    item.className = "suggestion-item";
                    item.textContent = place.name;

                    item.addEventListener("click", function () {
                        input.value = place.name;
                        suggestions.innerHTML = "";
                    });

                    suggestions.appendChild(item);
                });

            } catch (error) {
                console.error("Autocomplete error:", error);
            }

        }, 700);
    });

    // Close suggestions when clicking outside

    document.addEventListener("click", function (event) {
        if (
            event.target !== input &&
            !suggestions.contains(event.target)
        ) {
            suggestions.innerHTML = "";
        }
    });
}


// ====================================
// ACTIVATE AUTOCOMPLETE
// ====================================

setupAutocomplete("start", "start-suggestions");
setupAutocomplete("destination", "destination-suggestions");

const routePanel = document.getElementById("route-panel");
const minimizeButton = document.getElementById("minimize-route-panel");
const showPanelButton = document.getElementById("show-route-panel");

// Minimize or expand the planner
minimizeButton.addEventListener("click", function () {

    routePanel.classList.toggle("minimized");

    const isMinimized = routePanel.classList.contains("minimized");

    minimizeButton.textContent = isMinimized ? "+" : "−";

    minimizeButton.setAttribute(
        "aria-expanded",
        String(!isMinimized)
    );
});

// Reopen the planner
showPanelButton.addEventListener("click", function () {

    routePanel.classList.remove("hidden");
    routePanel.classList.remove("minimized");

    minimizeButton.textContent = "−";

    minimizeButton.setAttribute("aria-expanded", "true");

    showPanelButton.hidden = true;
});
// =====================================
// AI PANEL MINIMIZE / MAXIMIZE
// =====================================

const aiPanel = document.getElementById("ai-panel");

const minimizeAiButton = document.getElementById(
    "minimize-ai-panel"
);

minimizeAiButton.addEventListener("click", function () {

    aiPanel.classList.toggle("minimized");

    const isMinimized = aiPanel.classList.contains("minimized");

    minimizeAiButton.textContent = isMinimized ? "+" : "−";

    minimizeAiButton.setAttribute(
        "aria-expanded",
        String(!isMinimized)
    );

});

// =====================================
// FUEL CONSUMPTION CALCULATOR
// =====================================

// Average consumption in litres per 100 km
const vehicleConsumption = {
    small: 5.5,
    medium: 7.0,
    large: 9.0,
    van: 10.0
};

// Calculate and display fuel estimate
function updateFuelEstimate(distanceKm) {

    const vehicleCategory = document.getElementById(
        "vehicle-category"
    ).value;

    const fuelPrice = Number(
        document.getElementById("fuel-price").value
    );

    const consumption = vehicleConsumption[vehicleCategory];

    // Validate input
    if (
        !Number.isFinite(distanceKm) ||
        distanceKm < 0 ||
        !Number.isFinite(fuelPrice) ||
        fuelPrice < 0
    ) {
        document.getElementById("fuel-litres").textContent = "—";
        document.getElementById("fuel-cost").textContent = "Enter a valid price";
        return null;
    }

    // Calculate total fuel consumption
    const fuelLitres = distanceKm * consumption / 100;

    // Calculate estimated fuel cost
    const totalCost = fuelLitres * fuelPrice;

    // Display results
    document.getElementById("fuel-distance").textContent =
        `${distanceKm.toFixed(1)} km`;

    document.getElementById("fuel-consumption").textContent =
        `${consumption.toFixed(1)} L/100 km`;

    document.getElementById("fuel-litres").textContent =
        `${fuelLitres.toFixed(1)} litres`;

    document.getElementById("fuel-cost").textContent =
        `${totalCost.toFixed(2)} SEK`;
    
    return {
        distance_km: distanceKm,
        consumption: consumption,
        fuel_type: document.getElementById("fuel-type").value,
        fuel_price: fuelPrice,
        estimated_litres: fuelLitres,
        estimated_cost: totalCost
    };
}


// Update estimate when vehicle category changes
document.getElementById("vehicle-category")
    .addEventListener("change", function () {

        if (lastRouteDistanceKm !== null) {
            updateFuelEstimate(lastRouteDistanceKm);
        }

    });


// Update estimate when fuel price changes
document.getElementById("fuel-price")
    .addEventListener("input", function () {

        if (lastRouteDistanceKm !== null) {
            updateFuelEstimate(lastRouteDistanceKm);
        }

    });

    

// Escape text received from external data
function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, character => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    })[character]);
}


// Only allow HTTP or HTTPS website links
function safeWebsiteUrl(value) {
    try {
        const url = new URL(value);

        if (url.protocol === "http:" || url.protocol === "https:") {
            return escapeHtml(url.href);
        }
    } catch (error) {
        return "#";
    }

    return "#";
}

// ====================================
// GENERATE AI TRAVEL REPORT
// ====================================

document.getElementById("generate-ai-report")
    .addEventListener("click", async function () {

        const button = this;
        const status = document.getElementById("ai-report-status");

        if (!lastRoute || !lastWeatherForecasts.length) {
            status.textContent = "Please calculate a route first.";
            return;
        }

        // Get the latest fuel calculation
        const fuel = updateFuelEstimate(lastRouteDistanceKm);

        if (!fuel) {
            status.textContent = "Please enter a valid fuel price.";
            return;
        }

        // Calculate arrival time
        const arrival = new Date(
            lastDeparture.getTime() + lastRoute.duration * 1000
        );

        const routeData = {
            distance_km: lastRouteDistanceKm,
            driving_time_seconds: lastRoute.duration,
            departure: lastDeparture.toISOString(),
            arrival: arrival.toISOString()
        };

        const requestData = {
            route: routeData,
            weather: lastWeatherForecasts,
            fuel: fuel
        };

        button.disabled = true;
        button.textContent = "Generating report...";
        status.textContent = "Mistral AI is analysing your journey...";

        try {

            const response = await fetch("/ai/travel-report", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(requestData)
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(
                    data.error || "Could not generate travel report."
                );
            }

            if (!data.success || !data.report) {
                throw new Error("Invalid AI report received.");
            }

            displayAIReport(data.report);

            status.textContent = "Travel report generated successfully.";

        } catch (error) {

            console.error("AI report error:", error);

            status.textContent = error.message;

        } finally {

            button.disabled = false;
            button.textContent = "✦ Generate AI travel report";

        }

    });


// ====================================
// DISPLAY AI TRAVEL REPORT
// ====================================

function displayAIReport(report) {

    const results = document.getElementById("ai-report-results");

    results.hidden = false;

    // Risk level
    const riskElement = document.getElementById("ai-risk-level");

    riskElement.textContent = "Travel risk: " + report.risk_level;

    riskElement.className = "risk-" +
        report.risk_level.toLowerCase();

    // Overall summary
    document.getElementById("ai-overall-summary").textContent =
        report.overall_summary;

    // Weather analysis
    document.getElementById("ai-weather-analysis").textContent =
        report.weather_analysis;

    // Tyre recommendations
    document.getElementById("ai-tyre-recommendations").textContent =
        report.tyre_recommendations;

    // Fuel summary
    document.getElementById("ai-fuel-summary").textContent =
        report.fuel_summary;

    // Travel tips
    const tipsContainer = document.getElementById("ai-travel-tips");

    tipsContainer.replaceChildren();

    if (Array.isArray(report.travel_tips)) {

        const list = document.createElement("ul");

        report.travel_tips.forEach(tip => {

            const item = document.createElement("li");

            item.textContent = tip;

            list.appendChild(item);

        });

        tipsContainer.appendChild(list);
    }
}
// ====================================
// DISPLAY CHAT MESSAGE
// ====================================

function addChatMessage(message, sender) {

    const container = document.getElementById("ai-chat-messages");

    const messageElement = document.createElement("div");

    messageElement.className =
        "chat-message " +
        (sender === "user" ? "user-message" : "assistant-message");

    // Use textContent to prevent HTML injection
    messageElement.textContent = message;

    container.appendChild(messageElement);

    // Scroll to the latest message
    container.scrollTop = container.scrollHeight;

    return messageElement;
}


// ====================================
// SEND CHAT MESSAGE TO MISTRAL
// ====================================

async function sendChatMessage() {

    const input = document.getElementById("ai-chat-input");
    const sendButton = document.getElementById("ai-chat-send");
    const status = document.getElementById("ai-chat-status");

    const message = input.value.trim();

    if (!message || isChatLoading) {
        return;
    }

    if (!lastRoute || !lastWeatherForecasts.length) {
        status.textContent = "Please calculate a route first.";
        return;
    }

    // Get latest fuel calculation
    const fuel = updateFuelEstimate(lastRouteDistanceKm);

    if (!fuel) {
        status.textContent = "Please enter a valid fuel price.";
        return;
    }

    // Calculate arrival time
    const arrival = new Date(
        lastDeparture.getTime() + lastRoute.duration * 1000
    );

    const routeData = {
        distance_km: lastRouteDistanceKm,
        driving_time_seconds: lastRoute.duration,
        departure: lastDeparture.toISOString(),
        arrival: arrival.toISOString()
    };

    const requestData = {
        message: message,

        // Previous conversation messages
        history: chatHistory,

        // Current journey information
        context: {
            route: routeData,
            weather: lastWeatherForecasts,
            fuel: fuel
        }
    };

    // Display user's message
    addChatMessage(message, "user");

    input.value = "";

    isChatLoading = true;
    sendButton.disabled = true;
    input.disabled = true;

    status.textContent = "Mistral is thinking...";

    const loadingMessage = addChatMessage(
        "Thinking...",
        "assistant"
    );

    try {

        const response = await fetch("/ai/chat", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(requestData)
        });

        const data = await response.json();

        if (response.status === 429) {
            throw new Error(
                "You've reached the chat limit. Please wait a minute before asking again."
            );
        }

        if (!response.ok) {
            throw new Error(data.error || "Could not get an AI response.");
        }

        if (!data.success || typeof data.answer !== "string") {
            throw new Error("Invalid response from AI assistant.");
        }

        // Remove loading message
        loadingMessage.remove();

        // Display Mistral's answer
        addChatMessage(data.answer, "assistant");

        // Store conversation history
        chatHistory.push(
            { role: "user", content: message },
            { role: "assistant", content: data.answer }
        );

        // Keep only the latest 20 messages
        chatHistory = chatHistory.slice(-20);

        status.textContent = "Ask another question about your journey.";

    } catch (error) {

        console.error("AI chat error:", error);

        loadingMessage.remove();

        addChatMessage(
            "Sorry, I couldn't process your question. Please try again.",
            "assistant"
        );

        status.textContent = error.message;

    } finally {

        isChatLoading = false;

        sendButton.disabled = false;
        input.disabled = false;

        input.focus();
    }
}


// ====================================
// CHAT BUTTON EVENT
// ====================================

document.getElementById("ai-chat-send")
    .addEventListener("click", sendChatMessage);


// ====================================
// SEND MESSAGE WITH ENTER
// ====================================

document.getElementById("ai-chat-input")
    .addEventListener("keydown", function (event) {

        if (event.key === "Enter") {
            event.preventDefault();
            sendChatMessage();
        }

    });