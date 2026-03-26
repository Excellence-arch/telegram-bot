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
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: 'llama-3.3-70b-versatile',
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: prompt },
            { type: 'input_image', image_url: fileUrl },
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

  const text = response.data.choices[0].message.content;
  return JSON.parse(text);
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
