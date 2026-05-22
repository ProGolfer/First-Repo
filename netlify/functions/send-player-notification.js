exports.handler = async function(event) {
  try {
    const body = JSON.parse(event.body || "{}");

    const playerName = body.playerName || "";
    const cleanName = playerName.trim().toLowerCase();

    const message = body.message || "Your Golf Money Game status has been updated.";

    console.log("Sending player notification to:", cleanName);

    if (!cleanName) {
      return {
        statusCode: 400,
        body: "Missing playerName"
      };
    }

    const response = await fetch(
      "https://api.onesignal.com/notifications",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Key ${process.env.ONESIGNAL_REST_API_KEY}`
        },
        body: JSON.stringify({
          app_id: process.env.ONESIGNAL_APP_ID,

          headings: {
            en: "Golf Money Game"
          },

          contents: {
            en: message
          },

          filters: [
            {
              field: "tag",
              key: "player_name",
              relation: "=",
              value: cleanName
            }
          ]
        })
      }
    );

    const text = await response.text();

    console.log("OneSignal player response:", text);

    return {
      statusCode: 200,
      body: text
    };

  } catch (err) {
    console.error("send-player-notification error:", err);

    return {
      statusCode: 500,
      body: err.message
    };
  }
};
