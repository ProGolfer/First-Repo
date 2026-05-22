
exports.handler = async function(event) {
  try {
    if (event.httpMethod !== "POST") {
      return {
        statusCode: 405,
        body: JSON.stringify({ error: "Method not allowed" })
      };
    }

    const body = JSON.parse(event.body || "{}");
    const playerName = body.playerName || "A player";

    const response = await fetch("https://api.onesignal.com/notifications", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Key ${process.env.ONESIGNAL_REST_API_KEY}`
      },
      body: JSON.stringify({
        app_id: process.env.ONESIGNAL_APP_ID,
        headings: { en: "Golf Money Game" },
        contents: { en: `${playerName} registered and is waiting for approval` },
        filters: [
          { field: "tag", key: "role", relation: "=", value: "admin" }
        ]
      })
    });

    const data = await response.json();

    return {
      statusCode: response.ok ? 200 : 500,
      body: JSON.stringify(data)
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};
