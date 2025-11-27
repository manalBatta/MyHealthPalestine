const { JigsawStack } = require("jigsawstack");
require("dotenv").config();

let jigsawClient = null;
const getClient = () => {
  if (!jigsawClient) {
    const apiKey = process.env.JIGSAWSTACK_API_KEY;
    if (!apiKey) {
      console.warn(
        "[translator] Missing JIGSAWSTACK_API_KEY. Messages will not be translated."
      );
      console.log(
        "[translator] JIGSAWSTACK_API_KEY is:",
        process.env.JIGSAWSTACK_API_KEY
      );
      return null;
    }

    jigsawClient = JigsawStack({
      apiKey,
    });
  }

  return jigsawClient;
};

const translateText = async (text, targetLanguage = "en") => {
  const fallback = {
    translatedText: text,
    language: targetLanguage || "en",
  };

  console.debug("[translator] Called translateText with:", {
    text,
    targetLanguage,
  });

  if (!text) {
    console.debug(
      "[translator] No text provided, returning fallback:",
      fallback
    );
    return fallback;
  }

  const client = getClient();
  if (!client) {
    console.debug(
      "[translator] No JigsawStack client, returning fallback:",
      fallback
    );
    return fallback;
  }

  try {
    console.debug("[translator] Sending translation request to JigsawStack:", {
      text: [text],
      target_language: targetLanguage || "en",
    });

    const response = await client.translate.text({
      text: [text],
      target_language: targetLanguage || "en",
    });

    console.debug("[translator] Received translation response:", response);

    const translated =
      response?.translated_text?.[0] || fallback.translatedText;

    const result = {
      translatedText: translated,
      language: targetLanguage || "en",
    };

    console.debug("[translator] Translation result to return:", result);

    return result;
  } catch (error) {
    console.error("[translator] Translation error:", error.message || error);
    return fallback;
  }
};

module.exports = {
  translateText,
};
