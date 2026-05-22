exports.handler = async function(event) {
  try {
    const body = JSON.parse(event.body || "{}");

    const playerName = body.playerName;
    const message = body.message;

    const response = await fetch(
      "https://api.onesignal.com/notifications",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization":
            `Key ${process.env.ONESIGNAL_REST_API_KEY}`
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
              value: playerName
            }
          ]
        })
      }
    );

    return {
      statusCode: 200,
      body: await response.text()
    };

  } catch (err) {
    return {
      statusCode: 500,
      body: err.message
    };
  }
};
