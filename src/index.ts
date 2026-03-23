import { Hono } from "hono";
import htmlContent from "../public/index.html";
import { GameRoom } from "./game";

type Bindings = {
	GAME_ROOM: DurableObjectNamespace;
};

const app = new Hono<{ Bindings: Bindings }>();

// Serve HTML for home and rooms
app.get("/", (c) => c.html(htmlContent));
app.get("/room/:id", (c) => c.html(htmlContent));

// Handle WebSocket upgrade and route to Durable Object
app.get("/ws/:id", async (c) => {
	const roomId = c.req.param("id");
	const upgradeHeader = c.req.header("Upgrade");
	if (upgradeHeader !== "websocket") {
		return new Response("Expected WebSocket", { status: 426 });
	}

	const id = c.env.GAME_ROOM.idFromName(roomId);
	const stub = c.env.GAME_ROOM.get(id);

	return stub.fetch(c.req.raw);
});

export default app;
export { GameRoom };
