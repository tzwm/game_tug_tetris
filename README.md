# Tug-of-War Tetris

A real-time, competitive multiplayer Tetris game where two players share the exact same physical grid. Built entirely on the edge using [Cloudflare Workers](https://workers.cloudflare.com/) and [Durable Objects](https://developers.cloudflare.com/workers/learning/using-durable-objects/).

## 🎮 Play Now

**https://tetris.4444.wtf**

Open the link in two browser windows (or share with a friend) to start a match!

## 🕹️ Game Mechanics

Unlike traditional split-screen Tetris, both players exist in the same `10x40` arena:
- **Player 1 (Top)**: Pieces fall downwards.
- **Player 2 (Bottom)**: Pieces fall upwards (anti-gravity).
- **Shared Collision**: Pieces from both players meet in the middle and stack together.
- **Tug-of-War (The Push)**: When you clear a line, you physically push the entire shared stack of blocks towards your opponent, shrinking their space and expanding yours.
- **Win Condition**: If a player's spawn area is blocked, they lose.

### ✨ Special Mechanics

#### 🪨 Neutral Bedrock
Two neutral gray blocks sit at the center of the arena. They serve as the foundation for both players to build upon, and cannot be destroyed by either side.

#### 💔 NTR (Assimilation Bonus)
When you clear a line that contains your opponent's blocks, each opponent block counts toward a bonus push! Every 2 opponent blocks destroyed grants **+1 extra push distance**. Aggressively invade their territory for maximum impact!

#### 👻 Ghost Blocks
Newly placed blocks start in a "ghost" state (flashing). If a ghost block isn't connected to your stable blocks or the neutral bedrock, it will disappear after 2 seconds. However, if you place another block that connects it to a stable structure, the ghost block becomes permanent. This prevents spawn-camping while allowing strategic "bridge building" into enemy territory.

## 🛠 Technology Stack

Built to be extremely lightweight, fast, and fully serverless:
- **Backend**: [Hono](https://hono.dev/) + Cloudflare Workers
- **State & Multiplayer**: Cloudflare Durable Objects + WebSockets
- **Frontend**: Vanilla JavaScript + HTML5 Canvas (Zero dependencies)

## 🚀 Quick Start

1. **Install dependencies**:
   ```bash
   pnpm install
   ```

2. **Run locally**:
   ```bash
   pnpm run dev
   ```
   Open `http://localhost:8787` in two browser windows to play against yourself.

3. **Deploy to Cloudflare**:
   ```bash
   pnpm run deploy
   ```

## ⌨️ Controls

| Key | Action |
|-----|--------|
| ← → | Move piece left/right |
| ↑ | Rotate piece |
| ↓ | Soft drop |
| Space | Hard drop |

## 📜 License

ISC