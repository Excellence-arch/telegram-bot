const axios = require('axios');

async function analyzeImage(fileUrl, task) {
  const prompt = `
TASK: ${task}

Score relevance (0-100).
Return JSON:
{ "score": number, "verdict": "VALID" | "INVALID" | "IRRELEVANT" }
`;

  // Replace with OpenAI SDK if needed
  const response = await axios.post(
    'https://api.openai.com/v1/responses',
    {
      model: "gpt-4.1-mini",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            { type: "input_image", image_url: fileUrl }
          ]
        }
      ]
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      }
    }
  );

  const text = response.data.output[0].content[0].text;
  return JSON.parse(text);
}

module.exports = { analyzeImage };
