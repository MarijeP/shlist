// shlist Recipe Import Worker
// Fetches a recipe page and uses Claude to extract recipe details

const ALLOWED_ORIGIN = 'https://marijep.github.io';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
    }

    let url;
    try {
      const body = await request.json();
      url = body.url;
      if (!url) throw new Error('No URL provided');
    } catch (e) {
      return json({ error: 'Invalid request body' }, 400);
    }

    // ── Step 1: Fetch the recipe page ──
    let pageText;
    try {
      const pageRes = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; recipe-importer/1.0)',
          'Accept': 'text/html',
        },
        redirect: 'follow',
      });

      if (!pageRes.ok) throw new Error(`Page returned ${pageRes.status}`);

      const html = await pageRes.text();

      // Strip tags to get plain text
      pageText = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[\s\S]*?<\/nav>/gi, '')
        .replace(/<footer[\s\S]*?<\/footer>/gi, '')
        .replace(/<header[\s\S]*?<\/header>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 8000);

      if (pageText.length < 100) throw new Error('Could not extract text from page');

    } catch (e) {
      return json({ error: 'Could not fetch the recipe page: ' + e.message }, 422);
    }

    // ── Step 2: Call Claude to extract the recipe ──
    let recipe;
    try {
      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1500,
          system: `You are a recipe extraction assistant. Extract recipe details from webpage text and return ONLY valid JSON with no markdown, no backticks, no explanation.

Return exactly this structure:
{"name":"","category":"","ingredients":[{"qty":"","name":""}],"method":"","notes":""}

Rules:
- category must be one of: Breakfast, Lunch, Dinner, Baking, Soups, Salads, Desserts, Snacks, Condiments, Drinks. If unsure use Dinner.
- ingredients: split quantity and unit into qty (e.g. "2 cups"), name is just the ingredient (e.g. "flour")
- method: plain text, use newlines between steps, no numbering needed
- notes: any tips, serving suggestions, or variations. Leave empty string if none.
- If no recipe is found on the page, return {"error":"No recipe found on this page"}`,
          messages: [{
            role: 'user',
            content: `Extract the recipe from this webpage.\nURL: ${url}\n\n${pageText}`
          }]
        })
      });

      if (!claudeRes.ok) throw new Error('Claude API error: ' + claudeRes.status);

      const claudeData = await claudeRes.json();
      const rawText = claudeData.content.map(b => b.text || '').join('').trim();

      try {
        recipe = JSON.parse(rawText);
      } catch (e) {
        const match = rawText.match(/\{[\s\S]*\}/);
        if (match) recipe = JSON.parse(match[0]);
        else throw new Error('Could not parse Claude response');
      }

      if (recipe.error) return json({ error: recipe.error }, 422);

    } catch (e) {
      return json({ error: 'Recipe extraction failed: ' + e.message }, 500);
    }

    return json(recipe, 200);
  }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
  });
}
