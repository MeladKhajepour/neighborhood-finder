# Neighborhood Finder API Documentation

## Base URL
Local development: `http://localhost:3001`
Production: (to be deployed)

## Endpoints

### GET /health
Health check endpoint to verify the server is running.

**Response:**
```json
{
  "status": "Server is running"
}
```

---

### POST /api/recommendations
Get neighborhood recommendations based on user preferences.

**Request Body:**
```json
{
  "city": "string (required)",
  "preferences": "string (required, natural language description)"
}
```

**Example Request:**
```json
{
  "city": "San Francisco",
  "preferences": "close to gyms, quiet area, safe neighborhood"
}
```

**Response:**
```json
{
  "city": "San Francisco",
  "userPreferences": "close to gyms, quiet area, safe neighborhood",
  "recommendations": {
    "recommendations": [
      {
        "neighborhood": "Presidio",
        "matchScore": 0.8,
        "matchReasons": [
          "Quiet area as it's a residential neighborhood",
          "Safe neighborhood with less reported crime",
          "Close to gyms and parks"
        ],
        "concerns": [
          "Might be slightly expensive"
        ]
      }
    ],
    "summary": "Based on the user's preferences and the Reddit discussions, the neighborhoods of Presidio and Fillmore in San Francisco are recommended..."
  }
}
```

**Response Fields:**
- `city`: The city that was searched
- `userPreferences`: The original user preferences
- `recommendations.recommendations`: Array of neighborhood recommendations
  - `neighborhood`: Name of the neighborhood
  - `matchScore`: 0-1 score indicating how well it matches preferences
  - `matchReasons`: Array of reasons why this neighborhood matches
  - `concerns`: Array of potential concerns or drawbacks
- `recommendations.summary`: Summary analysis of recommendations

---

### POST /api/test-scrape
Test endpoint to see raw Reddit posts for given queries.

**Request Body:**
```json
{
  "queries": ["array", "of", "search", "queries"]
}
```

**Example Request:**
```json
{
  "queries": [
    "safe neighborhoods San Francisco",
    "best gyms San Francisco neighborhoods"
  ]
}
```

**Response:**
```json
{
  "queriesCount": 2,
  "postsScraped": 15,
  "posts": [
    "Title: Post title here\nContent: Post content excerpt...\nSubreddit: r/subredditname"
  ]
}
```

---

## Error Handling

All errors return appropriate HTTP status codes:
- `400`: Bad request (missing required fields)
- `500`: Server error

**Error Response:**
```json
{
  "error": "Error message describing what went wrong"
}
```

---

## How It Works

1. User inputs: City + Natural language preferences
2. System uses OpenAI to parse preferences and generate Reddit search queries
3. Dynamically discovers relevant subreddits for that city
4. Scrapes Reddit for posts matching the search queries
5. Intelligently filters posts for relevance to the user's preferences
6. Uses OpenAI to analyze filtered posts and generate neighborhood recommendations
7. Returns ranked recommendations with match scores and reasoning
