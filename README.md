# Tug-of-War Tetris

A real-time, competitive multiplayer Tetris game where two players share the exact same physical grid. Built entirely on the edge using [Cloudflare Workers](https://workers.cloudflare.com/) and [Durable Objects](https://developers.cloudflare.com/workers/learning/using-durable-objects/).

## 🎮 Game Mechanics

Unlike traditional split-screen Tetris, both players exist in the same `10x40` arena:
- **Player 1 (Top)**: Pieces fall downwards.
- **Player 2 (Bottom)**: Pieces fall upwards (anti-gravity).
- **Shared Collision**: Pieces from both players meet in the middle and stack together. You can even use your opponent's blocks to complete your own lines!
- **Tug-of-War (The Push)**: When you clear a line, you don't just send "garbage" to your opponent—you physically push the entire shared stack of blocks towards their side, shrinking their available space and expanding yours.
- **Win Condition**: If a player's spawn area is blocked, they lose.

## 🛠 Technology Stack

This project is built to be extremely lightweight, fast, and fully serverless:
- **Backend**: [Hono](https://hono.dev/) + Cloudflare Workers.
- **State & Multiplayer**: Cloudflare Durable Objects + WebSockets. The Durable Object acts as the authoritative game server, running at 20 FPS to process inputs and broadcast the game state.
- **Frontend**: Vanilla JavaScript and HTML5 Canvas (Zero dependencies, incredibly fast loading).

## 🚀 Quick Start

1. **Install dependencies**:
   ```bash
   pnpm install
   ```

2. **Run locally**:
   ```bash
   pnpm run dev
   ```
   Open `http://localhost:8787` in two different browser windows to play against yourself.

3. **Deploy to Cloudflare**:
   ```bash
   pnpm run deploy
   ```

## ⌨️ Controls

- **Arrow Left / Right**: Move piece
- **Arrow Up**: Rotate piece
- **Arrow Down**: Soft drop
- **Space**: Hard drop

## 📜 License

ISC
