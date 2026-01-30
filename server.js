require('dotenv').config();
const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const axios = require('axios');
const cheerio = require('cheerio');
const { Client } = require('@googlemaps/google-maps-services-js');

const app = express();
const port = 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Initialize OpenAI
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// Initialize Google Maps client
const mapsClient = new Client({});

// Mapbox API Key
const MAPBOX_API_KEY = process.env.MAPBOX_API_KEY;

// Function to dynamically discover relevant subreddits for a city
async function discoverSubreddits(city) {
    console.log(`\n🔎 DISCOVERING SUBREDDITS FOR: ${city}`);

    try {
        // Search for subreddits related to the city
        const url = `https://www.reddit.com/subreddits/search.json?q=${encodeURIComponent(city)}&limit=20`;

        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 10000
        });

        const subreddits = [];

        if (response.data && response.data.data && response.data.data.children) {
            response.data.data.children.forEach((child) => {
                const subreddit = child.data;

                // Filter for relevant subreddits
                const isRelevant =
                    subreddit.subscribers > 100 && // Must have at least 100 subscribers
                    !subreddit.over18 && // Not NSFW
                    (subreddit.display_name.toLowerCase().includes(city.toLowerCase()) ||
                     subreddit.public_description.toLowerCase().includes('neighborhood') ||
                     subreddit.public_description.toLowerCase().includes('live') ||
                     subreddit.public_description.toLowerCase().includes('ask'));

                if (isRelevant) {
                    subreddits.push(subreddit.display_name);
                }
            });
        }

        // If we found subreddits, use them. Otherwise fall back to generic patterns
        if (subreddits.length > 0) {
            console.log(`✅ Found ${subreddits.length} relevant subreddits: ${subreddits.join(', ')}\n`);
            return subreddits;
        } else {
            // Fallback: generate likely subreddit names based on city
            const cityLower = city.toLowerCase();
            const fallbackSubreddits = [
                cityLower,
                `${cityLower}housing`,
                `Ask${city}`,
                `${cityLower}neighborhoods`,
            ].filter(s => s.length > 0);

            console.log(`⚠️  No subreddits found, using fallback: ${fallbackSubreddits.join(', ')}\n`);
            return fallbackSubreddits;
        }
    } catch (error) {
        console.error(`❌ Error discovering subreddits: ${error.message}`);

        // Ultimate fallback
        const cityLower = city.toLowerCase();
        const fallback = [cityLower, `Ask${city}`];
        console.log(`⚠️  Using ultimate fallback: ${fallback.join(', ')}\n`);
        return fallback;
    }
}

// Function to identify relevant keywords from preferences
async function identifyKeywords(preferences) {
    const prompt = `Extract the key characteristics/keywords from these preferences: "${preferences}"

Return as JSON array of keywords:
["keyword1", "keyword2", ...]

Examples: "close to gyms" -> ["gyms", "fitness", "exercise"]
"safe neighborhoods" -> ["safe", "safety", "crime"]
"quiet area" -> ["quiet", "peaceful", "noise"]`;

    const response = await openai.chat.completions.create({
        model: 'gpt-4',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
    });

    let keywordsText = response.choices[0].message.content;
    keywordsText = keywordsText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    try {
        return JSON.parse(keywordsText);
    } catch {
        return ['neighborhood', 'living', 'area'];
    }
}

// Function to get city coordinates using Google Maps Geocoding
async function getCityCoordinates(city) {
    try {
        const response = await mapsClient.geocode({
            params: {
                address: city,
                key: process.env.GOOGLE_MAPS_API_KEY,
            },
        });

        if (response.data.results && response.data.results.length > 0) {
            const location = response.data.results[0].geometry.location;
            return { lat: location.lat, lng: location.lng };
        }
        return null;
    } catch (error) {
        console.error(`Error getting city coordinates: ${error.message}`);
        return null;
    }
}

// Function to get neighborhood boundaries using Nominatim (OpenStreetMap)
async function getNeighborhoodBoundaries(neighborhood, city) {
    try {
        // Use Nominatim API to get polygon boundaries for the neighborhood
        const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(neighborhood + ', ' + city)}&format=geojson&polygon_geojson=1&limit=1`;

        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'NeighborhoodFinder'
            },
            timeout: 10000
        });

        if (response.data && response.data.features && response.data.features.length > 0) {
            const feature = response.data.features[0];
            return {
                neighborhood: neighborhood,
                type: feature.geometry.type,
                coordinates: feature.geometry.coordinates,
                center: feature.bbox ? {
                    lat: (feature.bbox[1] + feature.bbox[3]) / 2,
                    lng: (feature.bbox[0] + feature.bbox[2]) / 2
                } : null
            };
        }
        return null;
    } catch (error) {
        console.error(`Error getting boundaries for ${neighborhood}: ${error.message}`);
        return null;
    }
}

// Function to get amenity coordinates in a city
async function getAmenityCoordinates(city, amenityType, limit = 5) {
    try {
        const cityCoords = await getCityCoordinates(city);
        if (!cityCoords) return [];

        const response = await mapsClient.placesNearby({
            params: {
                location: cityCoords,
                radius: 5000, // 5km radius
                type: amenityType,
                key: process.env.GOOGLE_MAPS_API_KEY,
            },
        });

        const places = response.data.results || [];
        return places.slice(0, limit).map(place => ({
            name: place.name,
            lat: place.geometry.location.lat,
            lng: place.geometry.location.lng,
            type: amenityType,
        }));
    } catch (error) {
        console.error(`Error getting ${amenityType} coordinates: ${error.message}`);
        return [];
    }
}

// Function to verify neighborhood amenities using Google Maps
async function verifyNeighborhoodAmenities(neighborhood, city, preferences) {
    console.log(`\n🗺️  VERIFYING AMENITIES FOR: ${neighborhood}, ${city}`);

    try {
        // Parse preferences to find amenity types
        const amenityKeywords = {
            gym: ['gym', 'fitness', 'crunch', 'planet fitness', 'la fitness', 'peloton'],
            grocery: ['grocery', 'supermarket', 'whole foods', 'trader joe', 'safeway'],
            transit: ['transit', 'metro', 'muni', 'bart', 'bus', 'public transportation'],
        };

        const foundAmenities = {};

        // Check for each amenity type
        for (const [type, keywords] of Object.entries(amenityKeywords)) {
            const preferencesLower = preferences.toLowerCase();
            if (keywords.some(kw => preferencesLower.includes(kw))) {
                try {
                    const response = await mapsClient.placesNearby({
                        params: {
                            location: { lat: 37.7749, lng: -122.4194 }, // Default to SF, will be improved
                            radius: 3000, // 3km radius
                            keyword: type,
                            key: process.env.GOOGLE_MAPS_API_KEY,
                        },
                    });

                    const nearbyPlaces = response.data.results || [];
                    foundAmenities[type] = nearbyPlaces.length > 0;
                    console.log(`  ✅ Found ${nearbyPlaces.length} ${type} locations nearby`);
                } catch (error) {
                    console.error(`  ⚠️  Could not verify ${type}:`, error.message);
                    foundAmenities[type] = null; // Null means unverified
                }
            }
        }

        return foundAmenities;
    } catch (error) {
        console.error(`❌ Error verifying amenities:`, error.message);
        return {};
    }
}

// Function to filter posts by relevance
async function filterRelevantPosts(posts, preferences) {
    console.log('\n🔍 FILTERING POSTS FOR RELEVANCE');
    console.log(`Filtering ${posts.length} posts...\n`);

    const filterPrompt = `Given these user preferences: "${preferences}"

Analyze EACH of these Reddit posts. For each post, answer:
1. Is this post relevant to finding neighborhoods based on the preferences?
2. Does it discuss the city's neighborhoods, living conditions, or specific areas?

Posts to analyze:
${posts.map((p, i) => `POST ${i + 1}: ${p}`).join('\n\n---\n\n')}

Return as JSON array with one object per post:
[
  { "postIndex": 1, "isRelevant": true/false, "reason": "brief reason" },
  ...
]`;

    const response = await openai.chat.completions.create({
        model: 'gpt-4',
        messages: [{ role: 'user', content: filterPrompt }],
        temperature: 0.5,
    });

    let filterText = response.choices[0].message.content;
    filterText = filterText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    let relevanceScores = [];
    try {
        relevanceScores = JSON.parse(filterText);
    } catch (e) {
        console.warn('Could not parse filter response, keeping all posts');
        return posts;
    }

    const relevantPosts = posts.filter((_, i) => {
        const score = relevanceScores.find(s => s.postIndex === i + 1);
        if (score && score.isRelevant) {
            console.log(`  ✅ Post ${i + 1}: Relevant - ${score.reason}`);
            return true;
        } else {
            console.log(`  ❌ Post ${i + 1}: Skipped - ${score?.reason || 'Not relevant'}`);
            return false;
        }
    });

    console.log(`\n✅ Kept ${relevantPosts.length}/${posts.length} relevant posts\n`);
    return relevantPosts;
}

// Reddit scraping function - searches specific subreddits
async function scrapeReddit(queries, city = null, subreddits = null) {
    const posts = [];
    console.log('\n📡 REDDIT SCRAPING STARTING');
    console.log(`Attempting to scrape ${queries.length} queries...\n`);

    // Use provided subreddits or dynamically discover them
    let searchSubreddits = subreddits;
    if (!searchSubreddits && city) {
        searchSubreddits = await discoverSubreddits(city);
    }
    if (!searchSubreddits) {
        searchSubreddits = ['AskReddit'];
    }

    console.log(`Searching in subreddits: ${searchSubreddits.join(', ')}\n`);

    for (const query of queries) {
        try {
            console.log(`  ⏳ Scraping: "${query}"`);

            // Build search URL with subreddit restrictions
            const subredditFilter = searchSubreddits.map(s => `subreddit:${s}`).join(' OR ');
            const fullQuery = `${query} ${subredditFilter}`;

            const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(fullQuery)}&type=post&sort=relevance&t=all&limit=10`;

            const response = await axios.get(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                },
                timeout: 10000
            });

            if (response.data && response.data.data && response.data.data.children) {
                let foundCount = 0;
                response.data.data.children.forEach((child) => {
                    const post = child.data;
                    if (post.title && post.selftext) {
                        // Get title and post content
                        const content = `Title: ${post.title}\nContent: ${post.selftext.substring(0, 300)}\nSubreddit: r/${post.subreddit}`;
                        posts.push(content);
                        foundCount++;
                    }
                });
                console.log(`  ✅ Found ${foundCount} posts for "${query}"\n`);
            }
        } catch (error) {
            console.error(`  ❌ Error scraping query "${query}": ${error.message}\n`);
        }
    }

    console.log(`📊 Total posts scraped: ${posts.length}\n`);
    return posts;
}

// Test endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'Server is running' });
});

// Test Reddit scraping endpoint
app.post('/api/test-scrape', async (req, res) => {
    try {
        const { queries } = req.body;

        if (!queries || !Array.isArray(queries)) {
            return res.status(400).json({ error: 'Queries array is required' });
        }

        console.log('\n🧪 TESTING REDDIT SCRAPING');
        console.log(`Queries to scrape: ${JSON.stringify(queries)}\n`);

        const posts = await scrapeReddit(queries);

        console.log('📊 SCRAPING RESULTS:');
        posts.forEach((post, i) => {
            console.log(`\n--- Post ${i + 1} ---`);
            console.log(post);
        });

        res.json({
            queriesCount: queries.length,
            postsScraped: posts.length,
            posts: posts,
        });
    } catch (error) {
        console.error('❌ Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Debug endpoint to see full process for a query
app.post('/api/debug-recommendations', async (req, res) => {
    try {
        const { city, preferences } = req.body;

        if (!city || !preferences) {
            return res.status(400).json({ error: 'City and preferences are required' });
        }

        console.log('\n🔍 DEBUG MODE: FULL PROCESS');
        console.log(`City: ${city}`);
        console.log(`Preferences: ${preferences}\n`);

        // Step 1: Parse preferences
        const parsingPrompt = `The user wants to stay in ${city} with these preferences: "${preferences}"

Extract the key preferences and suggest NEIGHBORHOOD-FOCUSED Reddit search queries.
Focus on finding neighborhood recommendations, living conditions, and area-specific discussions.
Avoid queries that are too specific about brands or services.

Return as JSON with this format:
{
  "preferences": ["preference1", "preference2", ...],
  "redditQueries": ["search query 1 (neighborhood focused)", "search query 2 (neighborhood focused)", ...]
}`;

        const parsingResponse = await openai.chat.completions.create({
            model: 'gpt-4',
            messages: [{ role: 'user', content: parsingPrompt }],
            temperature: 0.7,
        });

        let parsingText = parsingResponse.choices[0].message.content;
        parsingText = parsingText.replace(/```json\n?/g, '').replace(/```\n?/g, '');
        const parsedData = JSON.parse(parsingText);

        console.log('✅ Parsed preferences:', parsedData);

        // Step 2: Get subreddits and scrape
        const subreddits = await discoverSubreddits(city);
        const allPosts = await scrapeReddit(parsedData.redditQueries, city, subreddits);

        console.log(`\n📋 ALL SCRAPED POSTS (${allPosts.length} total):`);
        allPosts.forEach((post, i) => {
            console.log(`\n--- Post ${i + 1} ---`);
            console.log(post);
        });

        // Step 3: Filter
        const filteredPosts = allPosts.length > 0 ? await filterRelevantPosts(allPosts, preferences) : [];

        console.log(`\n📋 FILTERED POSTS (${filteredPosts.length} kept):`);
        filteredPosts.forEach((post, i) => {
            console.log(`\n--- Filtered Post ${i + 1} ---`);
            console.log(post);
        });

        // Return everything
        res.json({
            city,
            preferences,
            subredditsDiscovered: subreddits,
            allPostsScraped: allPosts,
            filteredPosts: filteredPosts,
            totalScraped: allPosts.length,
            totalKept: filteredPosts.length,
        });
    } catch (error) {
        console.error('❌ Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Main recommendations endpoint
app.post('/api/recommendations', async (req, res) => {
    try {
        const { city, preferences } = req.body;

        console.log('\n🚀 NEW REQUEST RECEIVED');
        console.log(`📍 City: ${city}`);
        console.log(`💭 User preferences: ${preferences}\n`);

        if (!city || !preferences) {
            return res.status(400).json({ error: 'City and preferences are required' });
        }

        // Step 1: Use OpenAI to parse preferences and generate Reddit search queries
        console.log('🤖 STEP 1: Parsing preferences with OpenAI...');
        const parsingPrompt = `The user wants to stay in ${city} with these preferences: "${preferences}"

Extract the key preferences and suggest NEIGHBORHOOD-FOCUSED Reddit search queries.
Focus on finding neighborhood recommendations, living conditions, and area-specific discussions.
Avoid queries that are too specific about brands or services.

Return as JSON with this format:
{
  "preferences": ["preference1", "preference2", ...],
  "redditQueries": ["search query 1 (neighborhood focused)", "search query 2 (neighborhood focused)", ...]
}

Example: If preferences are "close to Crunch Fitness, quiet, no homeless"
- Good queries: "quiet neighborhoods ${city}", "safest neighborhoods ${city}", "best neighborhoods to live ${city}"
- Bad queries: "Crunch Fitness locations ${city}"`;

        const parsingResponse = await openai.chat.completions.create({
            model: 'gpt-4',
            messages: [{ role: 'user', content: parsingPrompt }],
            temperature: 0.7,
        });

        let parsingText = parsingResponse.choices[0].message.content;
        // Remove markdown code blocks if present
        parsingText = parsingText.replace(/```json\n?/g, '').replace(/```\n?/g, '');
        const parsedData = JSON.parse(parsingText);
        console.log('✅ OpenAI parsed preferences:');
        console.log(`   Preferences: ${JSON.stringify(parsedData.preferences)}`);
        console.log(`   Reddit queries: ${JSON.stringify(parsedData.redditQueries)}\n`);

        // Step 2: Scrape Reddit with the queries (from relevant subreddits)
        const redditPosts = await scrapeReddit(parsedData.redditQueries, city);

        // Step 2.5: Filter posts for relevance
        const filteredPosts = redditPosts.length > 0
            ? await filterRelevantPosts(redditPosts, preferences)
            : [];

        const redditData = filteredPosts.length > 0
            ? filteredPosts.join('\n')
            : `Limited Reddit posts found. Using general knowledge about ${city} neighborhoods.`;
        console.log('📋 Filtered Reddit data to analyze:')
        console.log(`${redditData.substring(0, 200)}...\n`);

        // Step 3: Use OpenAI to analyze and recommend neighborhoods
        console.log('🤖 STEP 3: OpenAI analyzing neighborhoods...');
        const analysisPrompt = `Based on the following Reddit discussions about ${city} neighborhoods and the user's preferences (${preferences}), recommend the best neighborhoods for them.

Reddit data:
${redditData}

User preferences extracted: ${JSON.stringify(parsedData.preferences)}

Return as JSON with this format:
{
  "recommendations": [
    {
      "neighborhood": "Neighborhood Name",
      "matchScore": 0.9,
      "matchReasons": ["reason1", "reason2"],
      "concerns": ["any concerns"]
    }
  ],
  "summary": "Brief summary of findings"
}`;

        const analysisResponse = await openai.chat.completions.create({
            model: 'gpt-4',
            messages: [{ role: 'user', content: analysisPrompt }],
            temperature: 0.7,
        });

        let responseText = analysisResponse.choices[0].message.content;
        // Remove markdown code blocks if present
        responseText = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

        // Find JSON in response (in case OpenAI returns text with JSON embedded)
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            // If no JSON found, create fallback response
            console.warn('No JSON found in response, using fallback');
            const recommendations = {
                recommendations: [
                    {
                        neighborhood: "Downtown",
                        matchScore: 0.7,
                        matchReasons: parsedData.preferences,
                        concerns: ["Limited Reddit data available"]
                    }
                ],
                summary: "Unable to find specific Reddit data. Please verify the city name and try again."
            };
            return res.json({
                city,
                userPreferences: preferences,
                recommendations,
            });
        }

        const recommendations = JSON.parse(jsonMatch[0]);

        console.log('✅ OpenAI recommendations generated:');
        recommendations.recommendations.forEach((rec, i) => {
            console.log(`   ${i + 1}. ${rec.neighborhood} (Match: ${(rec.matchScore * 100).toFixed(0)}%)`);
            console.log(`      Reasons: ${rec.matchReasons.join(', ')}`);
        });

        // Get city coordinates and amenities
        console.log('\n📍 GETTING MAP DATA...');
        const cityCoords = await getCityCoordinates(city);
        console.log(`City coordinates: ${cityCoords?.lat}, ${cityCoords?.lng}`);

        // Use OpenAI to extract amenity types from preferences
        console.log('🔍 EXTRACTING AMENITIES FROM PREFERENCES...');
        const amenityExtractionPrompt = `From these user preferences: "${preferences}"

Extract the types of amenities/places they care about. Return as JSON array of Google Maps place types.
Map common terms to Google Maps types:
- gym/fitness/crunch/peloton -> "gym"
- grocery/supermarket/whole foods/trader joe -> "grocery_or_supermarket"
- transit/metro/muni/bart/bus -> "transit_station"
- restaurant/food/cafe/coffee -> "restaurant"
- park/outdoor/nature -> "park"
- hospital/doctor/medical -> "hospital"
- library -> "library"
- school -> "school"
- shopping/mall -> "shopping_mall"
- pharmacy -> "pharmacy"

Return ONLY a JSON array like: ["gym", "grocery_or_supermarket", "restaurant"]
Be smart - if they mention "close to a gym" extract "gym", if they say "good restaurants" extract "restaurant"
Only include amenities they actually mentioned or clearly implied.`;

        const amenityResponse = await openai.chat.completions.create({
            model: 'gpt-4',
            messages: [{ role: 'user', content: amenityExtractionPrompt }],
            temperature: 0.5,
        });

        let amenityText = amenityResponse.choices[0].message.content;
        amenityText = amenityText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

        let amenitiesNeeded = [];
        try {
            amenitiesNeeded = JSON.parse(amenityText);
        } catch (e) {
            console.warn('Could not parse amenities, using defaults');
            amenitiesNeeded = ['gym', 'grocery_or_supermarket'];
        }

        console.log(`Extracted amenities: ${amenitiesNeeded.join(', ')}`);

        const mapData = {
            cityCoordinates: cityCoords,
            amenities: {},
            neighborhoods: [],
        };

        // Get boundaries for each recommended neighborhood
        console.log('🗺️  FETCHING NEIGHBORHOOD BOUNDARIES...');
        for (const rec of recommendations.recommendations) {
            try {
                const boundaries = await getNeighborhoodBoundaries(rec.neighborhood, city);
                if (boundaries) {
                    mapData.neighborhoods.push(boundaries);
                    console.log(`✅ Got boundaries for ${rec.neighborhood}`);
                } else {
                    console.log(`⚠️ Could not get boundaries for ${rec.neighborhood}`);
                }
            } catch (error) {
                console.error(`⚠️ Error getting boundaries for ${rec.neighborhood}: ${error.message}`);
            }
        }

        // Get coordinates for each amenity type
        for (const amenityType of amenitiesNeeded) {
            try {
                const amenityCoords = await getAmenityCoordinates(city, amenityType);
                mapData.amenities[amenityType] = amenityCoords;
                console.log(`✅ Found ${amenityCoords.length} ${amenityType} locations`);
            } catch (error) {
                console.error(`⚠️ Error getting ${amenityType}: ${error.message}`);
                mapData.amenities[amenityType] = [];
            }
        }

        console.log(`\n📤 Sending response to client...\n`);

        res.json({
            city,
            userPreferences: preferences,
            recommendations,
            mapData,
        });
    } catch (error) {
        console.error('❌ ERROR:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.listen(port, () => {
    console.log(`🚀 Neighborhood Finder API running on port ${port}`);
});
