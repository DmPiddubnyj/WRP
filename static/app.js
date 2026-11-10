
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

        displayWeatherMarkers(forecasts);

        statusMessage.textContent += " | Finding places...";

        const places = await getPlaces(route);

        displayPlaceMarkers(places);
        displayPlaces(places);

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

// Store the latest calculated route distance
let lastRouteDistanceKm = null;


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
        return;
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

    
// =====================================
// PLACES ALONG THE ROUTE
// =====================================

let placeMarkers = [];

async function getPlaces(route) {

    const response = await fetch("/places", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            coordinates: route.geometry.coordinates
        })
    });

    const data = await response.json();

    if (!response.ok) {
        throw new Error(data.error || "Could not retrieve places");
    }

    return data.places;
}

function displayPlaceMarkers(places) {

    // Remove old place markers
    placeMarkers.forEach(marker => {
        map.removeLayer(marker);
    });

    placeMarkers = [];

    const placeIcons = {
        "Petrol station": "⛽",
        "Sightseeing": "📸"
    };

    places.forEach(place => {

        const symbol = placeIcons[place.category] || "📍";

        const icon = L.divIcon({
            className: "place-map-icon",
            html: `<div>${symbol}</div>`,
            iconSize: [34, 34],
            iconAnchor: [17, 17]
        });

        const marker = L.marker(
            [place.latitude, place.longitude],
            { icon: icon }
        ).addTo(map);

        marker.bindPopup(`
            <div class="place-popup">
                <h3>${symbol} ${escapeHtml(place.name)}</h3>
                <p><strong>Category:</strong> ${escapeHtml(place.category)}</p>
                ${place.address ? `<p><strong>Address:</strong> ${escapeHtml(place.address)}</p>` : ""}
                ${place.opening_hours ? `<p><strong>Opening hours:</strong> ${escapeHtml(place.opening_hours)}</p>` : ""}
                ${place.website ? `<p><a href="${safeWebsiteUrl(place.website)}" target="_blank" rel="noopener noreferrer">Visit website</a></p>` : ""}
            </div>
        `);

        placeMarkers.push(marker);
    });
}


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


// =====================================
// DISPLAY PLACES GROUPED BY CATEGORY
// =====================================

function displayPlaces(places) {

    const container = document.getElementById("places-results");
    const summary = document.getElementById("places-summary");

    container.innerHTML = "";

    if (!places.length) {
        summary.textContent = "No matching places found along this route.";
        return;
    }

    summary.textContent = `${places.length} places found along your route.`;

    // Category configuration and display order
    const categories = [
    {
        name: "Petrol station",
        title: "Petrol stations",
        icon: "⛽"
    },
    {
        name: "Sightseeing",
        title: "Sightseeing",
        icon: "📸"
    }
    ];

    categories.forEach(category => {

        // Select places belonging to this category
        const categoryPlaces = places.filter(place =>
            place.category === category.name
        );

        // Don't display empty categories
        if (categoryPlaces.length === 0) {
            return;
        }

        // Create category container
        const group = document.createElement("div");
        group.className = "place-category-group";

        // Create category heading
        const heading = document.createElement("div");
        heading.className = "place-category-heading";

        const title = document.createElement("strong");
        title.textContent = `${category.icon} ${category.title}`;

        const count = document.createElement("span");
        count.className = "place-category-count";
        count.textContent = categoryPlaces.length;

        heading.appendChild(title);
        heading.appendChild(count);

        group.appendChild(heading);

        // Sort places by distance from route
        categoryPlaces.sort((a, b) =>
            (a.distance_from_route_m ?? Infinity) -
            (b.distance_from_route_m ?? Infinity)
        );

        categoryPlaces.forEach(place => {

            const item = document.createElement("button");

            item.type = "button";
            item.className = "place-result";

            const name = document.createElement("strong");
            name.textContent = place.name;

            const distance = document.createElement("span");
            const distanceValue = place.distance_from_route_m;

            distance.textContent =
                Number.isFinite(distanceValue)
                    ? `${Math.round(distanceValue)} m from route`
                    : "Distance unavailable";

            item.appendChild(name);
            item.appendChild(distance);

            // Clicking a place focuses its map marker
            item.addEventListener("click", function () {

                map.setView(
                    [place.latitude, place.longitude],
                    15
                );

                const marker = placeMarkers.find(m => {
                    const position = m.getLatLng();

                    return (
                        Math.abs(position.lat - place.latitude) < 0.000001 &&
                        Math.abs(position.lng - place.longitude) < 0.000001
                    );
                });

                if (marker) {
                    marker.openPopup();
                }

            });

            group.appendChild(item);
        });

        container.appendChild(group);

    });
}

