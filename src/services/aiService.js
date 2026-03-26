const axios = require('axios');
// const Groq = require('groq-sdk');
require('dotenv').config();

// const groq = new Groq({
//   apiKey: process.env.OPENAI_API_KEY,
// });

async function analyzeImage(fileUrl, task) {
  const prompt = `
TASK: ${task}

Score relevance (0-100).
Return JSON:
{ "score": number, "verdict": "VALID" | "INVALID" | "IRRELEVANT" }
`;

  // const response = await groq.chat.completions.create({
  //   model: 'openai/gpt-oss-120b',
  //   messages: [{ role: 'user', content: prompt }],
  //   stream: false,
  //   max_tokens: 500,
  //   temperature: 0.7,
  // });

  try {
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'openai/gpt-oss-120b',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: fileUrl } },
            ],
          },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
      },
    );

    const text = response.data.choices?.[0]?.message?.content;
    return JSON.parse(text);
  } catch (error) {
    console.log('AI analysis failed, marking as INVALID', error.message);
    return { score: 0, verdict: 'INVALID' };
  }

  // const text = response.choices?.[0]?.message?.content;
  // console.log(text);
  // return JSON.parse(text);
}

// import Groq from 'groq-sdk';

// const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// export async function main() {
//   const chatCompletion = await getGroqChatCompletion();
//   // console.log(chatCompletion.choices[0]?.message?.content || '');
// }

// export async function getGroqChatCompletion() {
//   return groq.chat.completions.create({
//     messages: [
//       {
//         role: 'user',
//         content: 'Explain the importance of fast language models',
//       },
//     ],
//     model: 'openai/gpt-oss-20b',
//   });
// }

module.exports = { analyzeImage };
