import type { DurableObjectState, WebSocket } from "@cloudflare/workers-types";

const COLS = 10;
const ROWS = 40;

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
type Block = 0 | 1 | 2 | 3;

export class GameRoom {
	state: DurableObjectState;
	sessions: { ws: WebSocket; player: 1 | 2 | null }[] = [];
	grid: Block[][] = [];
	pieceA: Piece | null = null;
	pieceB: Piece | null = null;
	loopId: ReturnType<typeof setInterval> | null = null;
	gameOver: boolean = false;
	gameOverBroadcasted: boolean = false;
	winner: 1 | 2 | null = null;
	midLine: number = ROWS / 2; // Dynamic center line

	constructor(state: DurableObjectState) {
		this.state = state;
		this.initGame();
	}

	initGame() {
		this.grid = Array.from({ length: ROWS }, () => Array(COLS).fill(0));
		this.midLine = ROWS / 2;

		// Create two neutral blocks in the center, horizontally centered
		const centerRow = Math.floor(this.midLine);
		this.grid[centerRow][4] = 3; // Neutral gray block
		this.grid[centerRow][5] = 3; // Neutral gray block

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
			if (this.checkCollision(this.pieceA, this.pieceB)) {
				this.gameOver = true;
				this.winner = 2; // B wins if A can't spawn
				this.broadcastGameOver();
			}
		} else {
			// B spawns at the bottom. Since shape is top-left anchored, y should be ROWS - shape.length
			this.pieceB = { shape, pos: { x: 3, y: ROWS - shape.length }, owner };
			if (this.checkCollision(this.pieceB, this.pieceA)) {
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

		// Assign player
		let assignedPlayer: 1 | 2 | null = null;
		if (!this.sessions.find((s) => s.player === 1)) {
			assignedPlayer = 1;
		} else if (!this.sessions.find((s) => s.player === 2)) {
			assignedPlayer = 2;
		}

		this.sessions.push({ ws: server, player: assignedPlayer });

		server.send(JSON.stringify({ type: "init", player: assignedPlayer }));

		// Start game loop if not started
		if (!this.loopId && this.sessions.filter((s) => s.player).length === 2) {
			this.initGame();
			this.loopId = setInterval(() => this.tick(), 500);
			this.broadcast({ type: "start" });
		} else if (this.loopId) {
			this.broadcastState(); // send state to new spectator or reconnect
		}

		return new Response(null, {
			status: 101,
			webSocket: client,
		});
	}

	webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
		const session = this.sessions.find((s) => s.ws === ws);
		// Only accept input when game is running (loopId exists) and not over
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
			// Room is empty, stop the game loop
			if (this.loopId) {
				clearInterval(this.loopId);
				this.loopId = null;
			}
			// Reset game state for next players
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
			// For A, down is +y. For B, down (towards center) is -y
			const dy = player === 1 ? 1 : -1;
			moved = this.move(piece, 0, dy);
		} else if (action === "rotate") {
			this.rotate(piece);
			moved = true; // rotate might fail inside but we can just broadcast
		} else if (action === "drop") {
			const dy = player === 1 ? 1 : -1;
			while (this.move(piece, 0, dy)) {}
			// After hard drop, check if piece disappeared or should lock
			if (this.isPieceOutOfBounds(piece)) {
				this.spawnPiece(player);
			} else {
				this.lockPiece(piece);
			}
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
		// If piece is completely out of bounds after move, stop moving
		if (this.isPieceOutOfBounds(piece)) {
			return false;
		}
		return true;
	}

	rotate(piece: Piece) {
		const oldShape = piece.shape;
		// Transpose and reverse rows (90 deg clockwise)
		const newShape = oldShape[0].map((_val, index) =>
			oldShape.map((row) => row[index]).reverse(),
		);
		piece.shape = newShape;
		// Wall kick (simple)
		const otherPiece = piece.owner === 1 ? this.pieceB : this.pieceA;
		if (this.checkCollision(piece, otherPiece)) {
			piece.shape = oldShape; // Revert if collides
		}
	}

	checkCollision(piece: Piece, otherPiece: Piece | null = null): boolean {
		for (let r = 0; r < piece.shape.length; r++) {
			for (let c = 0; c < piece.shape[r].length; c++) {
				if (piece.shape[r][c] !== 0) {
					const nx = piece.pos.x + c;
					const ny = piece.pos.y + r;
					// Side bounds check (left/right walls)
					if (nx < 0 || nx >= COLS) return true;
					// Vertical bounds - let pieces pass through and disappear
					// Player A falls down (exits at bottom), Player B falls up (exits at top)
					// We check bounds separately in tick() for "disappear" logic
					// Grid check (only if in bounds)
					if (ny >= 0 && ny < ROWS && this.grid[ny][nx] !== 0) return true;
					// Check collision with other active piece (only if in bounds)
					if (otherPiece && ny >= 0 && ny < ROWS) {
						for (let or = 0; or < otherPiece.shape.length; or++) {
							for (let oc = 0; oc < otherPiece.shape[or].length; oc++) {
								if (otherPiece.shape[or][oc] !== 0) {
									const ox = otherPiece.pos.x + oc;
									const oy = otherPiece.pos.y + or;
									if (nx === ox && ny === oy) return true;
								}
							}
						}
					}
				}
			}
		}
		return false;
	}

	// Check if piece has completely left the board (should disappear)
	isPieceOutOfBounds(piece: Piece): boolean {
		for (let r = 0; r < piece.shape.length; r++) {
			for (let c = 0; c < piece.shape[r].length; c++) {
				if (piece.shape[r][c] !== 0) {
					const ny = piece.pos.y + r;
					// Player A falls down, disappears at bottom
					if (piece.owner === 1 && ny < ROWS) return false;
					// Player B falls up, disappears at top
					if (piece.owner === 2 && ny >= 0) return false;
				}
			}
		}
		return true;
	}

	lockPiece(piece: Piece) {
		for (let r = 0; r < piece.shape.length; r++) {
			for (let c = 0; c < piece.shape[r].length; c++) {
				if (piece.shape[r][c] !== 0) {
					const ny = piece.pos.y + r;
					const nx = piece.pos.x + c;
					if (ny >= 0 && ny < ROWS && nx >= 0 && nx < COLS) {
						this.grid[ny][nx] = piece.owner;
					}
				}
			}
		}

		this.clearLines(piece.owner);
		this.spawnPiece(piece.owner);
	}

	clearLines(owner: 1 | 2) {
		const fullRows: number[] = [];
		let opponentBlocksDestroyed = 0;

		// Step 1: Scan ENTIRE board for full lines (allowing NTR logic!)
		for (let r = 0; r < ROWS; r++) {
			let isFull = true;
			for (let c = 0; c < COLS; c++) {
				if (this.grid[r][c] === 0) {
					isFull = false;
					break;
				}
			}
			if (isFull) {
				fullRows.push(r);
				// Count opponent blocks for NTR Bonus
				for (let c = 0; c < COLS; c++) {
					if (this.grid[r][c] === (owner === 1 ? 2 : 1)) {
						opponentBlocksDestroyed++;
					}
				}
			}
		}

		if (fullRows.length === 0) return;

		const linesCleared = fullRows.length;
		// Mechanism 2: NTR Assimilation Bonus
		// Every 2 opponent blocks destroyed = +1 Push distance!
		const ntrBonus = Math.floor(opponentBlocksDestroyed / 2);
		const totalPush = linesCleared + ntrBonus;

		// Step 2: Move midLine first
		if (owner === 1) {
			this.midLine += totalPush;
		} else {
			this.midLine -= totalPush;
		}

		// Step 3: Shift ALL blocks to follow the midLine push
		if (owner === 1) {
			// midLine moves down, ALL blocks shift down
			for (let y = ROWS - 1; y >= 0; y--) {
				const sourceY = y - totalPush;
				for (let x = 0; x < COLS; x++) {
					this.grid[y][x] = sourceY >= 0 ? this.grid[sourceY][x] : 0;
				}
			}
		} else {
			// midLine moves up, ALL blocks shift up
			for (let y = 0; y < ROWS; y++) {
				const sourceY = y + totalPush;
				for (let x = 0; x < COLS; x++) {
					this.grid[y][x] = sourceY < ROWS ? this.grid[sourceY][x] : 0;
				}
			}
		}

		// Step 4: Clear the full rows (now at new positions) and collapse
		// Full rows shifted in the same direction as the push
		const shiftedFullRows = fullRows.map((r) =>
			owner === 1 ? r + totalPush : r - totalPush,
		);

		// Remove the full rows and collapse
		if (owner === 1) {
			// A's gravity is down: collapse from bottom, remove full rows
			// Sort rows descending to remove from bottom up
			shiftedFullRows.sort((a, b) => b - a);
			for (const row of shiftedFullRows) {
				// Shift rows 0 to row-1 down by 1
				for (let y = row; y > 0; y--) {
					for (let x = 0; x < COLS; x++) {
						this.grid[y][x] = this.grid[y - 1][x];
					}
				}
				// Clear top row
				for (let x = 0; x < COLS; x++) {
					this.grid[0][x] = 0;
				}
			}
		} else {
			// B's gravity is up: collapse from top, remove full rows
			// Sort rows ascending to remove from top down
			shiftedFullRows.sort((a, b) => a - b);
			for (const row of shiftedFullRows) {
				// Shift rows row+1 to ROWS-1 up by 1
				for (let y = row; y < ROWS - 1; y++) {
					for (let x = 0; x < COLS; x++) {
						this.grid[y][x] = this.grid[y + 1][x];
					}
				}
				// Clear bottom row
				for (let x = 0; x < COLS; x++) {
					this.grid[ROWS - 1][x] = 0;
				}
			}
		}

		// Step 5: Win check
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
				// Collision - check if A's piece is out of bounds (should disappear)
				if (this.isPieceOutOfBounds(this.pieceA)) {
					disappearA = true;
				} else {
					lockA = true;
				}
			} else {
				// Moved successfully - check if now out of bounds
				if (this.isPieceOutOfBounds(this.pieceA)) {
					disappearA = true;
				}
			}
		}
		if (this.pieceB) {
			const moved = this.move(this.pieceB, 0, -1);
			if (!moved) {
				// Collision - check if B's piece is out of bounds (should disappear)
				if (this.isPieceOutOfBounds(this.pieceB)) {
					disappearB = true;
				} else {
					lockB = true;
				}
			} else {
				// Moved successfully - check if now out of bounds
				if (this.isPieceOutOfBounds(this.pieceB)) {
					disappearB = true;
				}
			}
		}

		// Handle locks AFTER both move attempts to avoid race conditions bias
		if (lockA && this.pieceA) this.lockPiece(this.pieceA);
		if (lockB && this.pieceB) this.lockPiece(this.pieceB);

		// Handle disappearances - piece vanishes, spawn new one
		if (disappearA) this.spawnPiece(1);
		if (disappearB) this.spawnPiece(2);

		this.broadcastState();

		if (this.gameOver) {
			this.broadcastGameOver();
		}
	}

	broadcastState() {
		const state = {
			type: "state",
			grid: this.grid,
			pieceA: this.pieceA,
			pieceB: this.pieceB,
			midLine: this.midLine,
		};
		this.broadcast(state);
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
