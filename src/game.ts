import type { DurableObjectState, WebSocket } from "@cloudflare/workers-types";

const COLS = 10;
const ROWS = 40;
const GHOST_LIFETIME_TICKS = 4; // 2s at 500ms per tick

const SHAPES = [
	[[1, 1, 1, 1]], // I
	[
		[1, 1],
		[1, 1],
	], // O
	[
		[0, 1, 0],
		[1, 1, 1],
	], // T
	[
		[1, 0, 0],
		[1, 1, 1],
	], // J
	[
		[0, 0, 1],
		[1, 1, 1],
	], // L
	[
		[0, 1, 1],
		[1, 1, 0],
	], // S
	[
		[1, 1, 0],
		[0, 1, 1],
	], // Z
];

interface Position {
	x: number;
	y: number;
}
interface Piece {
	shape: number[][];
	pos: Position;
	owner: 1 | 2;
}
type Block = 0 | 1 | 2 | 3 | 4 | 5;

export class GameRoom {
	state: DurableObjectState;
	sessions: { ws: WebSocket; player: 1 | 2 | null }[] = [];
	grid: Block[][] = [];
	ghostTimers: number[][] = [];
	pieceA: Piece | null = null;
	pieceB: Piece | null = null;
	loopId: ReturnType<typeof setInterval> | null = null;
	gameOver = false;
	gameOverBroadcasted = false;
	winner: 1 | 2 | null = null;
	midLine = ROWS / 2;

	constructor(state: DurableObjectState) {
		this.state = state;
		this.initGame();
	}

	initGame() {
		this.grid = Array.from({ length: ROWS }, () => Array(COLS).fill(0));
		this.ghostTimers = Array.from({ length: ROWS }, () => Array(COLS).fill(0));
		this.midLine = ROWS / 2;

		const centerRow = Math.floor(this.midLine);
		this.grid[centerRow][4] = 3;
		this.grid[centerRow][5] = 3;

		this.gameOver = false;
		this.gameOverBroadcasted = false;
		this.winner = null;
		this.spawnPiece(1);
		this.spawnPiece(2);
	}

	spawnPiece(owner: 1 | 2) {
		const shape = SHAPES[Math.floor(Math.random() * SHAPES.length)];
		if (owner === 1) {
			this.pieceA = { shape, pos: { x: 3, y: 0 }, owner };
			if (this.checkCollision(this.pieceA, null)) {
				this.gameOver = true;
				this.winner = 2;
				this.broadcastGameOver();
			}
		} else {
			this.pieceB = { shape, pos: { x: 3, y: ROWS - shape.length }, owner };
			if (this.checkCollision(this.pieceB, null)) {
				this.gameOver = true;
				this.winner = 1;
				this.broadcastGameOver();
			}
		}
	}

	async fetch(request: Request) {
		const upgradeHeader = request.headers.get("Upgrade");
		if (!upgradeHeader || upgradeHeader !== "websocket") {
			return new Response("Expected Upgrade: websocket", { status: 426 });
		}

		const [client, server] = Object.values(new WebSocketPair());
		this.state.acceptWebSocket(server);

		let assignedPlayer: 1 | 2 | null = null;
		if (!this.sessions.find((s) => s.player === 1)) assignedPlayer = 1;
		else if (!this.sessions.find((s) => s.player === 2)) assignedPlayer = 2;

		this.sessions.push({ ws: server, player: assignedPlayer });
		server.send(JSON.stringify({ type: "init", player: assignedPlayer }));

		if (!this.loopId && this.sessions.filter((s) => s.player).length === 2) {
			this.initGame();
			this.loopId = setInterval(() => this.tick(), 500);
			this.broadcast({ type: "start" });
		} else if (this.loopId) {
			this.broadcastState();
		}

		return new Response(null, { status: 101, webSocket: client });
	}

	webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
		const session = this.sessions.find((s) => s.ws === ws);
		if (!session || !session.player || !this.loopId || this.gameOver) return;

		try {
			const data = JSON.parse(message as string);
			this.handleInput(session.player, data.action);
		} catch (_e) {
			// ignore invalid JSON
		}
	}

	webSocketClose(ws: WebSocket) {
		this.sessions = this.sessions.filter((s) => s.ws !== ws);
		if (this.sessions.length === 0) {
			if (this.loopId) {
				clearInterval(this.loopId);
				this.loopId = null;
			}
			this.gameOver = true;
			this.gameOverBroadcasted = false;
		}
	}

	handleInput(player: 1 | 2, action: string) {
		const piece = player === 1 ? this.pieceA : this.pieceB;
		if (!piece) return;

		let moved = false;
		if (action === "left") moved = this.move(piece, -1, 0);
		else if (action === "right") moved = this.move(piece, 1, 0);
		else if (action === "down") {
			const dy = player === 1 ? 1 : -1;
			moved = this.move(piece, 0, dy);
		} else if (action === "rotate") {
			this.rotate(piece);
			moved = true;
		} else if (action === "drop") {
			const dy = player === 1 ? 1 : -1;
			while (this.move(piece, 0, dy)) {}
			if (this.isPieceOutOfBounds(piece)) this.spawnPiece(player);
			else this.lockPiece(piece);
		}

		if (moved || action === "drop") this.broadcastState();
		if (this.gameOver) this.broadcastGameOver();
	}

	move(piece: Piece, dx: number, dy: number): boolean {
		piece.pos.x += dx;
		piece.pos.y += dy;
		const otherPiece = piece.owner === 1 ? this.pieceB : this.pieceA;
		if (this.checkCollision(piece, otherPiece)) {
			piece.pos.x -= dx;
			piece.pos.y -= dy;
			return false;
		}
		if (this.isPieceOutOfBounds(piece)) return false;
		return true;
	}

	rotate(piece: Piece) {
		const oldShape = piece.shape;
		const newShape = oldShape[0].map((_val, index) =>
			oldShape.map((row) => row[index]).reverse(),
		);
		piece.shape = newShape;
		const otherPiece = piece.owner === 1 ? this.pieceB : this.pieceA;
		if (this.checkCollision(piece, otherPiece)) piece.shape = oldShape;
	}

	checkCollision(piece: Piece, otherPiece: Piece | null = null): boolean {
		for (let r = 0; r < piece.shape.length; r++) {
			for (let c = 0; c < piece.shape[r].length; c++) {
				if (piece.shape[r][c] === 0) continue;
				const nx = piece.pos.x + c;
				const ny = piece.pos.y + r;
				if (nx < 0 || nx >= COLS) return true;
				if (ny >= 0 && ny < ROWS && this.grid[ny][nx] !== 0) return true;
				if (otherPiece && ny >= 0 && ny < ROWS) {
					for (let or = 0; or < otherPiece.shape.length; or++) {
						for (let oc = 0; oc < otherPiece.shape[or].length; oc++) {
							if (otherPiece.shape[or][oc] === 0) continue;
							const ox = otherPiece.pos.x + oc;
							const oy = otherPiece.pos.y + or;
							if (nx === ox && ny === oy) return true;
						}
					}
				}
			}
		}
		return false;
	}

	isPieceOutOfBounds(piece: Piece): boolean {
		for (let r = 0; r < piece.shape.length; r++) {
			for (let c = 0; c < piece.shape[r].length; c++) {
				if (piece.shape[r][c] === 0) continue;
				const ny = piece.pos.y + r;
				if (piece.owner === 1 && ny < ROWS) return false;
				if (piece.owner === 2 && ny >= 0) return false;
			}
		}
		return true;
	}

	ghostTypeForOwner(owner: 1 | 2): 4 | 5 {
		return owner === 1 ? 4 : 5;
	}

	blockBelongsToOwner(block: Block, owner: 1 | 2): boolean {
		return owner === 1
			? block === 1 || block === 4
			: block === 2 || block === 5;
	}

	blockCountsAsOpponent(block: Block, owner: 1 | 2): boolean {
		return owner === 1
			? block === 2 || block === 5
			: block === 1 || block === 4;
	}

	clearCell(y: number, x: number) {
		this.grid[y][x] = 0;
		this.ghostTimers[y][x] = 0;
	}

	lockPiece(piece: Piece) {
		const ghostType = this.ghostTypeForOwner(piece.owner);
		for (let r = 0; r < piece.shape.length; r++) {
			for (let c = 0; c < piece.shape[r].length; c++) {
				if (piece.shape[r][c] === 0) continue;
				const ny = piece.pos.y + r;
				const nx = piece.pos.x + c;
				if (ny >= 0 && ny < ROWS && nx >= 0 && nx < COLS) {
					this.grid[ny][nx] = ghostType;
					this.ghostTimers[ny][nx] = GHOST_LIFETIME_TICKS;
				}
			}
		}

		this.resolveGhosts(piece.owner);
		this.clearLines(piece.owner);
		this.spawnPiece(piece.owner);
	}

	resolveGhosts(owner: 1 | 2) {
		const visited = Array.from({ length: ROWS }, () => Array(COLS).fill(false));
		const ghostType = this.ghostTypeForOwner(owner);

		for (let y = 0; y < ROWS; y++) {
			for (let x = 0; x < COLS; x++) {
				if (visited[y][x] || !this.blockBelongsToOwner(this.grid[y][x], owner))
					continue;

				const queue: [number, number][] = [[y, x]];
				const component: [number, number][] = [];
				let head = 0;
				let anchored = false;

				while (head < queue.length) {
					const [cy, cx] = queue[head++];
					if (cy < 0 || cy >= ROWS || cx < 0 || cx >= COLS) continue;
					if (
						visited[cy][cx] ||
						!this.blockBelongsToOwner(this.grid[cy][cx], owner)
					) {
						continue;
					}
					visited[cy][cx] = true;
					component.push([cy, cx]);

					if (this.grid[cy][cx] === owner) anchored = true;

					const neighbors: [number, number][] = [
						[cy - 1, cx],
						[cy + 1, cx],
						[cy, cx - 1],
						[cy, cx + 1],
					];
					for (const [ny, nx] of neighbors) {
						if (ny < 0 || ny >= ROWS || nx < 0 || nx >= COLS) continue;
						const neighbor = this.grid[ny][nx];
						if (neighbor === 3) anchored = true;
						if (!visited[ny][nx] && this.blockBelongsToOwner(neighbor, owner)) {
							queue.push([ny, nx]);
						}
					}
				}

				if (anchored) {
					for (const [cy, cx] of component) {
						if (this.grid[cy][cx] === ghostType) {
							this.grid[cy][cx] = owner;
							this.ghostTimers[cy][cx] = 0;
						}
					}
				}
			}
		}
	}

	decayGhosts() {
		for (let y = 0; y < ROWS; y++) {
			for (let x = 0; x < COLS; x++) {
				if (this.grid[y][x] !== 4 && this.grid[y][x] !== 5) continue;
				this.ghostTimers[y][x] -= 1;
				if (this.ghostTimers[y][x] <= 0) this.clearCell(y, x);
			}
		}
	}

	clearLines(owner: 1 | 2) {
		const fullRows: number[] = [];
		let opponentBlocksDestroyed = 0;

		for (let r = 0; r < ROWS; r++) {
			let isFull = true;
			for (let c = 0; c < COLS; c++) {
				if (this.grid[r][c] === 0) {
					isFull = false;
					break;
				}
			}
			if (!isFull) continue;
			fullRows.push(r);
			for (let c = 0; c < COLS; c++) {
				if (this.blockCountsAsOpponent(this.grid[r][c], owner)) {
					opponentBlocksDestroyed++;
				}
			}
		}

		if (fullRows.length === 0) return;

		const linesCleared = fullRows.length;
		const ntrBonus = Math.floor(opponentBlocksDestroyed / 2);
		const totalPush = linesCleared + ntrBonus;

		if (owner === 1) this.midLine += totalPush;
		else this.midLine -= totalPush;

		if (owner === 1) {
			for (let y = ROWS - 1; y >= 0; y--) {
				const sourceY = y - totalPush;
				for (let x = 0; x < COLS; x++) {
					if (sourceY >= 0) {
						this.grid[y][x] = this.grid[sourceY][x];
						this.ghostTimers[y][x] = this.ghostTimers[sourceY][x];
					} else {
						this.clearCell(y, x);
					}
				}
			}
		} else {
			for (let y = 0; y < ROWS; y++) {
				const sourceY = y + totalPush;
				for (let x = 0; x < COLS; x++) {
					if (sourceY < ROWS) {
						this.grid[y][x] = this.grid[sourceY][x];
						this.ghostTimers[y][x] = this.ghostTimers[sourceY][x];
					} else {
						this.clearCell(y, x);
					}
				}
			}
		}

		const shiftedFullRows = fullRows.map((r) =>
			owner === 1 ? r + totalPush : r - totalPush,
		);

		if (owner === 1) {
			shiftedFullRows.sort((a, b) => b - a);
			for (const row of shiftedFullRows) {
				for (let y = row; y > 0; y--) {
					for (let x = 0; x < COLS; x++) {
						this.grid[y][x] = this.grid[y - 1][x];
						this.ghostTimers[y][x] = this.ghostTimers[y - 1][x];
					}
				}
				for (let x = 0; x < COLS; x++) this.clearCell(0, x);
			}
		} else {
			shiftedFullRows.sort((a, b) => a - b);
			for (const row of shiftedFullRows) {
				for (let y = row; y < ROWS - 1; y++) {
					for (let x = 0; x < COLS; x++) {
						this.grid[y][x] = this.grid[y + 1][x];
						this.ghostTimers[y][x] = this.ghostTimers[y + 1][x];
					}
				}
				for (let x = 0; x < COLS; x++) this.clearCell(ROWS - 1, x);
			}
		}

		this.resolveGhosts(1);
		this.resolveGhosts(2);

		if (owner === 1 && this.midLine >= ROWS) {
			this.gameOver = true;
			this.winner = 1;
		}
		if (owner === 2 && this.midLine <= 0) {
			this.gameOver = true;
			this.winner = 2;
		}
	}

	tick() {
		if (this.gameOver) return;

		let lockA = false;
		let lockB = false;
		let disappearA = false;
		let disappearB = false;

		if (this.pieceA) {
			const moved = this.move(this.pieceA, 0, 1);
			if (!moved) {
				if (this.isPieceOutOfBounds(this.pieceA)) disappearA = true;
				else lockA = true;
			} else if (this.isPieceOutOfBounds(this.pieceA)) {
				disappearA = true;
			}
		}
		if (this.pieceB) {
			const moved = this.move(this.pieceB, 0, -1);
			if (!moved) {
				if (this.isPieceOutOfBounds(this.pieceB)) disappearB = true;
				else lockB = true;
			} else if (this.isPieceOutOfBounds(this.pieceB)) {
				disappearB = true;
			}
		}

		if (lockA && this.pieceA) this.lockPiece(this.pieceA);
		if (lockB && this.pieceB) this.lockPiece(this.pieceB);
		if (disappearA) this.spawnPiece(1);
		if (disappearB) this.spawnPiece(2);

		this.resolveGhosts(1);
		this.resolveGhosts(2);
		this.decayGhosts();
		this.clearLines(1);
		this.clearLines(2);

		this.broadcastState();
		if (this.gameOver) this.broadcastGameOver();
	}

	getGhostPosition(piece: Piece): Position {
		const ghost = { ...piece, pos: { ...piece.pos } };
		const dy = piece.owner === 1 ? 1 : -1;
		const otherPiece = piece.owner === 1 ? this.pieceB : this.pieceA;

		while (true) {
			ghost.pos.y += dy;
			if (this.checkCollision(ghost, otherPiece)) {
				ghost.pos.y -= dy;
				break;
			}
			if (this.isPieceOutOfBounds(ghost)) {
				ghost.pos.y -= dy;
				break;
			}
		}

		return ghost.pos;
	}

	broadcastState() {
		const ghostA = this.pieceA ? this.getGhostPosition(this.pieceA) : null;
		const ghostB = this.pieceB ? this.getGhostPosition(this.pieceB) : null;

		this.broadcast({
			type: "state",
			grid: this.grid,
			pieceA: this.pieceA,
			pieceB: this.pieceB,
			ghostA,
			ghostB,
			midLine: this.midLine,
		});
	}

	broadcast(data: unknown) {
		const msg = JSON.stringify(data);
		this.sessions.forEach((s) => {
			try {
				s.ws.send(msg);
			} catch (_e) {
				// ignore
			}
		});
	}

	broadcastGameOver() {
		if (this.gameOverBroadcasted) return;
		this.gameOverBroadcasted = true;
		this.broadcast({ type: "gameover", winner: this.winner });
		if (this.loopId) {
			clearInterval(this.loopId);
			this.loopId = null;
		}
	}
}
