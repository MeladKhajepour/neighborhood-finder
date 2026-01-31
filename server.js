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

// Function to get ALL amenity coordinates in a city (pagination)
async function getAllAmenityCoordinates(city, amenityType, specificNames = []) {
    try {
        const cityCoords = await getCityCoordinates(city);
        if (!cityCoords) return [];

        const allPlaces = [];
        let nextPageToken = null;

        // If specific brand names are provided, search for those specifically
        if (specificNames.length > 0) {
            for (const brandName of specificNames) {
                try {
                    console.log(`    Searching for: ${brandName}`);
                    const response = await mapsClient.placesNearby({
                        params: {
                            location: cityCoords,
                            radius: 8000,
                            keyword: brandName,
                            type: amenityType,
                            key: process.env.GOOGLE_MAPS_API_KEY,
                        },
                    });

                    if (response.data.results) {
                        // Strict filtering - only include results that match the brand name
                        const brandLower = brandName.toLowerCase();
                        const filtered = response.data.results.filter(place => {
                            const placeName = place.name.toLowerCase();
                            // Check if brand name appears in the place name
                            // Split by spaces to match any part of the brand
                            const brandParts = brandLower.split(/\s+/).filter(p => p.length > 2); // Only significant words
                            return brandParts.some(part => placeName.includes(part)) &&
                                   !placeName.includes('google') && // Exclude Google's own locations
                                   !placeName.includes('test'); // Exclude test locations
                        });
                        console.log(`    Found ${response.data.results.length} total results, filtered to ${filtered.length} matching ${brandName}`);
                        allPlaces.push(...filtered);
                    }

                    await new Promise(resolve => setTimeout(resolve, 200));
                } catch (error) {
                    console.error(`Error searching for ${brandName}: ${error.message}`);
                }
            }
        } else {
            // Generic search by type only if no specific brand
            for (let page = 0; page < 3; page++) {
                try {
                    const response = await mapsClient.placesNearby({
                        params: {
                            location: cityCoords,
                            radius: 8000,
                            type: amenityType,
                            pagetoken: nextPageToken,
                            key: process.env.GOOGLE_MAPS_API_KEY,
                        },
                    });

                    if (response.data.results) {
                        allPlaces.push(...response.data.results);
                    }

                    nextPageToken = response.data.next_page_token;
                    if (!nextPageToken) break;

                    await new Promise(resolve => setTimeout(resolve, 200));
                } catch (error) {
                    console.error(`Error on page ${page}: ${error.message}`);
                    break;
                }
            }
        }

        return allPlaces.map(place => ({
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

// Function to get amenity coordinates in a city (limited, for display)
async function getAmenityCoordinates(city, amenityType, limit = 5, specificNames = []) {
    try {
        const cityCoords = await getCityCoordinates(city);
        if (!cityCoords) return [];

        let places = [];

        // If specific brand names provided, search for those
        if (specificNames.length > 0) {
            for (const brandName of specificNames) {
                try {
                    const response = await mapsClient.placesNearby({
                        params: {
                            location: cityCoords,
                            radius: 8000,
                            keyword: brandName,
                            type: amenityType,
                            key: process.env.GOOGLE_MAPS_API_KEY,
                        },
                    });

                    if (response.data.results) {
                        const brandLower = brandName.toLowerCase();
                        const filtered = response.data.results.filter(place => {
                            const placeName = place.name.toLowerCase();
                            const brandParts = brandLower.split(/\s+/).filter(p => p.length > 2);
                            return brandParts.some(part => placeName.includes(part));
                        });
                        places.push(...filtered);
                    }
                    await new Promise(resolve => setTimeout(resolve, 200));
                } catch (error) {
                    console.error(`Error searching for ${brandName}: ${error.message}`);
                }
            }
        } else {
            // Generic search if no specific brands
            const response = await mapsClient.placesNearby({
                params: {
                    location: cityCoords,
                    radius: 8000,
                    type: amenityType,
                    key: process.env.GOOGLE_MAPS_API_KEY,
                },
            });
            places = response.data.results || [];
        }

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

// Function to identify neighborhood from coordinates using reverse geocoding
async function getNeighborhoodFromCoordinates(lat, lng) {
    try {
        const response = await mapsClient.reverseGeocode({
            params: {
                latlng: { lat, lng },
                key: process.env.GOOGLE_MAPS_API_KEY,
            },
        });

        if (response.data.results && response.data.results.length > 0) {
            // Look for neighborhood-level address component
            const result = response.data.results[0];
            const addressComponents = result.address_components || [];

            // Try to find a neighborhood or locality
            let neighborhood = null;
            for (const component of addressComponents) {
                if (component.types.includes('neighborhood')) {
                    return component.long_name;
                }
            }
            for (const component of addressComponents) {
                if (component.types.includes('locality')) {
                    return component.long_name;
                }
            }
            // Fallback to first address component
            return result.formatted_address.split(',')[0];
        }
        return null;
    } catch (error) {
        console.error(`Error getting neighborhood: ${error.message}`);
        return null;
    }
}

// Function to cluster amenities by neighborhood and score neighborhoods
async function scoreNeighborhoodsByAmenities(city, amenitiesNeeded, specificBrands = {}) {
    console.log('\n🏘️  SCORING NEIGHBORHOODS BY AMENITY CLUSTERS...');

    const neighborhoodScores = {};
    const neighborhoodAmenities = {};

    // For each amenity type, get all instances and group by neighborhood
    for (const amenityType of amenitiesNeeded) {
        try {
            const brandNames = specificBrands[amenityType] || [];
            console.log(`  📍 Finding all ${amenityType} in ${city}${brandNames.length > 0 ? ` (${brandNames.join(', ')})` : ''}...`);
            const amenities = await getAllAmenityCoordinates(city, amenityType, brandNames);
            console.log(`  ✅ Found ${amenities.length} ${amenityType} locations`);

            // Map each amenity to a neighborhood
            for (const amenity of amenities) {
                const neighborhood = await getNeighborhoodFromCoordinates(amenity.lat, amenity.lng);
                if (neighborhood) {
                    if (!neighborhoodScores[neighborhood]) {
                        neighborhoodScores[neighborhood] = {};
                        neighborhoodAmenities[neighborhood] = {};
                    }
                    if (!neighborhoodScores[neighborhood][amenityType]) {
                        neighborhoodScores[neighborhood][amenityType] = 0;
                        neighborhoodAmenities[neighborhood][amenityType] = [];
                    }
                    neighborhoodScores[neighborhood][amenityType]++;
                    neighborhoodAmenities[neighborhood][amenityType].push(amenity);
                }
            }
        } catch (error) {
            console.error(`⚠️ Error processing ${amenityType}: ${error.message}`);
        }
    }

    // Calculate overall scores for neighborhoods
    const scoredNeighborhoods = Object.entries(neighborhoodScores).map(([neighborhood, amenityCount]) => {
        // Score based on total amenities and variety
        const totalAmenities = Object.values(amenityCount).reduce((a, b) => a + b, 0);
        const amenityTypes = Object.keys(amenityCount).length;
        const score = totalAmenities + (amenityTypes * 5); // Bonus for variety

        return {
            neighborhood,
            amenityScore: score,
            amenityCounts: amenityCount,
            totalAmenities: totalAmenities,
            amenityTypes: amenityTypes,
        };
    }).sort((a, b) => b.amenityScore - a.amenityScore);

    console.log(`✅ Identified ${scoredNeighborhoods.length} neighborhoods with amenities`);
    scoredNeighborhoods.slice(0, 5).forEach((n, i) => {
        console.log(`  ${i + 1}. ${n.neighborhood}: ${n.totalAmenities} amenities (${n.amenityTypes} types)`);
    });

    return { scoredNeighborhoods, neighborhoodAmenities };
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

// Main recommendations endpoint - AMENITY-FIRST APPROACH
app.post('/api/recommendations', async (req, res) => {
    try {
        const { city, preferences } = req.body;

        console.log('\n🚀 NEW REQUEST RECEIVED');
        console.log(`📍 City: ${city}`);
        console.log(`💭 User preferences: ${preferences}\n`);

        if (!city || !preferences) {
            return res.status(400).json({ error: 'City and preferences are required' });
        }

        // Step 1: Extract amenity types and specific brands/names
        console.log('🤖 STEP 1: Parsing preferences...');
        const amenityExtractionPrompt = `From these user preferences: "${preferences}"

Extract both:
1. The TYPES of amenities (gym, grocery, etc.)
2. The SPECIFIC BRANDS/NAMES if mentioned (e.g., "Crunch Fitness", "Whole Foods", "BART")

Return as JSON:
{
  "amenities": [
    {
      "type": "gym",
      "specificNames": ["Crunch Fitness", "Planet Fitness"]
    },
    {
      "type": "grocery_or_supermarket",
      "specificNames": ["Whole Foods"]
    }
  ]
}

Type mappings:
- gym/fitness/crunch/peloton/la fitness -> "gym"
- grocery/supermarket/whole foods/trader joe -> "grocery_or_supermarket"
- transit/metro/muni/bart/bus -> "transit_station"
- restaurant/food/cafe/coffee -> "restaurant"
- park/outdoor/nature -> "park"
- hospital/doctor/medical -> "hospital"
- library -> "library"
- school -> "school"
- shopping/mall -> "shopping_mall"
- pharmacy -> "pharmacy"

Only include amenities they actually mentioned or implied.
If no specific names mentioned, use empty array for specificNames.`;

        const amenityResponse = await openai.chat.completions.create({
            model: 'gpt-4',
            messages: [{ role: 'user', content: amenityExtractionPrompt }],
            temperature: 0.5,
        });

        let amenityText = amenityResponse.choices[0].message.content;
        amenityText = amenityText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

        let amenitiesNeeded = [];
        let specificBrands = {};
        try {
            const parsed = JSON.parse(amenityText);
            amenitiesNeeded = parsed.amenities.map(a => a.type);
            parsed.amenities.forEach(a => {
                specificBrands[a.type] = a.specificNames || [];
            });
        } catch (e) {
            console.warn('Could not parse amenities, using defaults');
            amenitiesNeeded = ['gym', 'grocery_or_supermarket'];
        }

        console.log(`Extracted amenities: ${amenitiesNeeded.join(', ') || 'None (qualitative search)'}`);
        if (Object.keys(specificBrands).length > 0) {
            console.log(`Specific brands: ${JSON.stringify(specificBrands)}`);
        }

        // Step 2: Score neighborhoods based on amenity clusters (if amenities specified)
        let scoredNeighborhoods = [];
        let neighborhoodAmenities = {};

        if (amenitiesNeeded.length > 0) {
            const result = await scoreNeighborhoodsByAmenities(city, amenitiesNeeded, specificBrands);
            scoredNeighborhoods = result.scoredNeighborhoods;
            neighborhoodAmenities = result.neighborhoodAmenities;

            if (scoredNeighborhoods.length === 0) {
                return res.status(400).json({ error: `No neighborhoods found with requested amenities in ${city}` });
            }
        } else {
            // No amenities specified - use Reddit data to identify neighborhoods
            console.log('🏘️  NO AMENITIES SPECIFIED - USING REDDIT DATA TO FIND NEIGHBORHOODS...');

            // Extract neighborhood names mentioned in Reddit posts
            const neighborhoodExtractionPrompt = `From these Reddit posts about ${city}, extract the names of neighborhoods/areas mentioned:

${redditData}

Return as JSON array of neighborhood names: ["neighborhood1", "neighborhood2", ...]
Only include specific neighborhood names, not generic terms.`;

            const neighborhoodExtractionResponse = await openai.chat.completions.create({
                model: 'gpt-4',
                messages: [{ role: 'user', content: neighborhoodExtractionPrompt }],
                temperature: 0.5,
            });

            let neighborhoodText = neighborhoodExtractionResponse.choices[0].message.content;
            neighborhoodText = neighborhoodText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

            try {
                const mentionedNeighborhoods = JSON.parse(neighborhoodText);
                scoredNeighborhoods = mentionedNeighborhoods.map(n => ({
                    neighborhood: n,
                    totalAmenities: 0,
                    amenityCounts: {},
                    amenityScore: 0
                }));
            } catch (e) {
                console.warn('Could not extract neighborhoods from Reddit');
                scoredNeighborhoods = [{ neighborhood: 'Downtown', totalAmenities: 0, amenityCounts: {}, amenityScore: 0 }];
            }
        }

        // Step 3: Get qualitative preferences from Reddit for filtering
        console.log('\n📡 STEP 2: Getting qualitative preferences from Reddit...');
        const qualitativePrompt = `The user wants to stay in ${city} with these preferences: "${preferences}"

Generate Reddit search queries focused on QUALITATIVE aspects (quiet, clean, safe, etc).
Ignore amenity-specific queries - those are handled separately.

Return as JSON array like: ["quiet neighborhoods ${city}", "safest neighborhoods ${city}"]`;

        const qualitativeResponse = await openai.chat.completions.create({
            model: 'gpt-4',
            messages: [{ role: 'user', content: qualitativePrompt }],
            temperature: 0.7,
        });

        let qualText = qualitativeResponse.choices[0].message.content;
        qualText = qualText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        let redditQueries = [];
        try {
            redditQueries = JSON.parse(qualText);
        } catch (e) {
            redditQueries = [`neighborhoods in ${city}`, `best places to live in ${city}`];
        }

        // Scrape Reddit for qualitative data
        const redditPosts = await scrapeReddit(redditQueries, city);
        const filteredPosts = redditPosts.length > 0
            ? await filterRelevantPosts(redditPosts, preferences)
            : [];

        const redditData = filteredPosts.length > 0
            ? filteredPosts.join('\n')
            : `Limited Reddit posts found.`;

        // Step 4: Use OpenAI to score qualitative match for top neighborhoods
        console.log('\n🤖 STEP 3: Scoring neighborhoods by qualitative preferences...');
        const topNeighborhoods = scoredNeighborhoods.slice(0, 5).map(n => n.neighborhood).join('", "');

        const qualitativeScoringPrompt = `Based on Reddit discussions about ${city} neighborhoods and the user's preferences (${preferences}),
score these neighborhoods on qualitative match (0-1):

Neighborhoods to score: "${topNeighborhoods}"

Reddit data:
${redditData}

Return as JSON object: { "neighborhoodName": 0.85, ... }
Consider factors like: quiet, clean, safe, friendly, walkable, etc.
Use values between 0 and 1.`;

        const scoringResponse = await openai.chat.completions.create({
            model: 'gpt-4',
            messages: [{ role: 'user', content: qualitativeScoringPrompt }],
            temperature: 0.7,
        });

        let scoringText = scoringResponse.choices[0].message.content;
        scoringText = scoringText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        let qualitativeScores = {};
        try {
            qualitativeScores = JSON.parse(scoringText);
        } catch (e) {
            console.warn('Could not parse qualitative scores');
        }

        // Ask OpenAI to identify specific concerns for top neighborhoods
        console.log('\n⚠️ STEP 4: Identifying concerns for neighborhoods...');
        const neighborhoodsForConcerns = scoredNeighborhoods.slice(0, 5).map(n => n.neighborhood).join('", "');

        const concernsPrompt = `Based on Reddit discussions about ${city} neighborhoods and the user's preferences (${preferences}),
identify specific concerns or potential downsides for these neighborhoods: "${neighborhoodsForConcerns}"

Reddit data:
${redditData}

For each neighborhood, list 1-2 legitimate concerns (e.g., high rent, parking issues, long commute, noise, safety concerns, lack of public transit, etc.)

Return as JSON object: { "neighborhoodName": ["concern1", "concern2"], ... }
Only include concerns mentioned in Reddit or that are realistic for the area.
Return empty array if no concerns found.`;

        const concernsResponse = await openai.chat.completions.create({
            model: 'gpt-4',
            messages: [{ role: 'user', content: concernsPrompt }],
            temperature: 0.7,
        });

        let concernsText = concernsResponse.choices[0].message.content;
        concernsText = concernsText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        let concernsMap = {};
        try {
            concernsMap = JSON.parse(concernsText);
            console.log(`✅ Extracted concerns: ${JSON.stringify(concernsMap)}`);
        } catch (e) {
            console.warn('Could not parse concerns:', e.message);
        }

        // Generate fallback concerns if not found or empty
        scoredNeighborhoods.slice(0, 5).forEach(n => {
            if (!concernsMap[n.neighborhood] || concernsMap[n.neighborhood].length === 0) {
                const concerns = [];

                // Generate contextual concerns based on neighborhood data
                if (n.totalAmenities < 5) {
                    concerns.push('Limited number of requested amenities nearby');
                }
                if (n.amenityTypes < amenitiesNeeded.length) {
                    concerns.push('Not all requested amenity types available in this neighborhood');
                }
                if (redditPosts.length === 0) {
                    concerns.push('Limited community feedback available');
                }

                // If no concerns generated, add a neutral one
                if (concerns.length === 0) {
                    concerns.push('Research more on community forums and local resources');
                }

                concernsMap[n.neighborhood] = concerns;
            }
        });

        // Return ranked recommendations (order itself indicates quality)
        const recommendations = {
            recommendations: scoredNeighborhoods.slice(0, 5).map(n => {
                const reasons = [];
                if (n.totalAmenities > 0) {
                    reasons.push(`${n.totalAmenities} ${amenitiesNeeded.length > 1 ? 'amenities' : 'amenity'} nearby`);
                }
                if (Object.keys(n.amenityCounts).length > 0) {
                    reasons.push(`${Object.keys(n.amenityCounts).length} types of amenities`);
                }
                if (redditPosts.length > 0) {
                    reasons.push('Well-reviewed on community forums');
                }

                return {
                    neighborhood: n.neighborhood,
                    matchReasons: reasons.length > 0 ? reasons : ['Strong neighborhood match'],
                    concerns: concernsMap[n.neighborhood] || [],
                    amenityBreakdown: n.amenityCounts
                };
            })
        };

        console.log('✅ Recommendations generated:');
        recommendations.recommendations.forEach((rec, i) => {
            console.log(`   ${i + 1}. ${rec.neighborhood} (Match: ${(rec.matchScore * 100).toFixed(0)}%)`);
        });

        // Get city coordinates
        console.log('\n📍 GETTING MAP DATA...');
        const cityCoords = await getCityCoordinates(city);
        console.log(`City coordinates: ${cityCoords?.lat}, ${cityCoords?.lng}`);

        const mapData = {
            cityCoordinates: cityCoords,
            amenities: {},
            neighborhoodAmenities: {},
        };

        // Get full amenity coordinates for map display (with brand filtering if specified)
        for (const amenityType of amenitiesNeeded) {
            try {
                const brandNames = specificBrands[amenityType] || [];
                const amenityCoords = await getAmenityCoordinates(city, amenityType, 10, brandNames);
                mapData.amenities[amenityType] = amenityCoords;
                console.log(`✅ Found ${amenityCoords.length} ${amenityType} locations for display${brandNames.length > 0 ? ` (filtered)` : ''}`);
            } catch (error) {
                console.error(`⚠️ Error getting ${amenityType}: ${error.message}`);
                mapData.amenities[amenityType] = [];
            }
        }

        // Add neighborhood-specific amenities
        recommendations.recommendations.forEach(rec => {
            mapData.neighborhoodAmenities[rec.neighborhood] = {};
            for (const amenityType of amenitiesNeeded) {
                if (neighborhoodAmenities[rec.neighborhood] && neighborhoodAmenities[rec.neighborhood][amenityType]) {
                    mapData.neighborhoodAmenities[rec.neighborhood][amenityType] =
                        neighborhoodAmenities[rec.neighborhood][amenityType].slice(0, 5);
                } else {
                    mapData.neighborhoodAmenities[rec.neighborhood][amenityType] = [];
                }
            }
        });

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
