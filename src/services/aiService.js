const Groq = require('groq-sdk');
require('dotenv').config();

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

async function analyzeImage(fileUrl, task) {
  const prompt = `
You are judging a screenshot submission for a contest.

TASK: ${task}

Analyze the image and determine if it's relevant to the task above.
Score relevance from 0-100 based on how well it matches the task.

Return ONLY valid JSON in this exact format (no other text):
{"score": number, "verdict": "VALID" | "INVALID" | "IRRELEVANT"}

Scoring guidelines:
- 1: relevant
- 0: irrelevant
`;

  try {
    const completion = await groq.chat.completions.create({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: prompt,
            },
            {
              type: 'image_url',
              image_url: {
                url: fileUrl,
              },
            },
          ],
        },
      ],
      temperature: 0.7,
      max_completion_tokens: 200,
      top_p: 1,
      stream: false,
      response_format: { type: 'json_object' },
    });

    const text = completion.choices[0]?.message?.content;

    if (!text) {
      throw new Error('Empty response from AI');
    }

    // Parse the JSON response
    const parsed = JSON.parse(text);

    return {
      score: Math.min(100, Math.max(0, parseInt(parsed.score) || 0)),
      verdict: ['VALID', 'INVALID', 'IRRELEVANT'].includes(parsed.verdict)
        ? parsed.verdict
        : 'INVALID',
    };
  } catch (error) {
    console.error('AI analysis failed:', error.message);
    return { score: 0, verdict: 'INVALID' };
  }
}

module.exports = { analyzeImage };
