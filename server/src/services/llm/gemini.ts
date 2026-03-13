export interface GenerateTextParams {
  model?: string;
  system?: string;
  prompt: string;
}

export async function generateText({ model, system, prompt }: GenerateTextParams): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  const modelId = model ?? process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';

  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured');
  }

  if (!modelId) {
    throw new Error('GEMINI_MODEL is not configured');
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;

  const body = {
    contents: [
      {
        role: 'user',
        parts: [{ text: system ? `${system}\n\n${prompt}` : prompt }]
      }
    ]
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini HTTP ${res.status}: ${text}`);
  }

  const data = (await res.json()) as any;

  const text =
    data.candidates?.[0]?.content?.parts?.[0]?.text ??
    data.candidates?.[0]?.output_text ??
    '';

  if (!text) {
    throw new Error('Gemini returned no text');
  }

  return text.trim();
}
