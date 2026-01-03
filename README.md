# Solvan - Solana Vanity Address Generator

A Telegram bot for generating custom Solana vanity addresses. Generate addresses that start or end with your chosen text!

## Features

- 🔑 **Prefix & Suffix Generation** - Create addresses starting or ending with custom text
- ⚡ **Fast Generation** - Optimized Python backend with concurrent processing
- 🔐 **Secure** - All addresses generated locally, never logged
- 📊 **Queue Management** - Efficient job queue with Redis
- 📈 **Statistics Tracking** - Track your generated addresses
- 🚀 **Production Ready** - Docker containerized, scalable architecture

## Quick Start

### Prerequisites
- Docker & Docker Compose
- Telegram Bot Token (from [@BotFather](https://t.me/botfather))

### Setup

1. Clone the repository:
```bash
git clone https://github.com/whale-professor/Solvan.git
cd Solvan
```

2. Create `.env` file:
```env
TELEGRAM_BOT_TOKEN=your_bot_token_here
REDIS_HOST=redis
REDIS_PORT=6379
```

3. Deploy:
```bash
docker-compose up -d
```

4. Check logs:
```bash
docker logs -f solana-vanity-bot
```

## Usage

Start the bot on Telegram:

```
/start   - Welcome & stats
/generate - Start vanity address generation
/info    - How vanity addresses work
/stats   - View your statistics
```

### Generation Process

1. **Choose Type**: Select Prefix or Suffix
2. **Enter String**: Type 1-4 characters (valid Base58)
3. **Case Sensitivity**: Choose if search is case-sensitive
4. **Wait**: Bot generates and queues the address
5. **Receive**: Get wallet details with private key

### Valid Characters

**Can use**: `1-9`, `A-Z` (except `O`, `I`), `a-z` (except `l`)
**Cannot use**: `0`, `O`, `I`, `l` (Base58 standard)

## Architecture

```
┌─────────────────┐
│  Telegram Bot   │  (Node.js + Telegraf)
├─────────────────┤
│  BullMQ Queue   │  (Job queue & processing)
├─────────────────┤
│     Redis       │  (Queue & result storage)
├─────────────────┤
│  Python Worker  │  (Vanity generation)
└─────────────────┘
```

## Project Structure

```
.
├── vanity-bot.js              # Main bot code
├── vanity_generator.py        # Python vanity address generator
├── docker-compose.yml         # Docker orchestration
├── Dockerfile                 # Bot container
├── .env                       # Environment variables (create this)
├── package.json              # Node dependencies
├── README.md                 # This file
├── ROADMAP.md               # Future features & plans
└── LICENSE                  # MIT license
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `TELEGRAM_BOT_TOKEN` | Your Telegram bot token | Required |
| `REDIS_HOST` | Redis server hostname | `redis` |
| `REDIS_PORT` | Redis server port | `6379` |

## Performance

Expected generation times (approximate):

| String Length | Time (Insensitive) | Time (Sensitive) |
|---------------|-------------------|-----------------|
| 1 char | 1 sec | 1-2 sec |
| 2 chars | 1-5 sec | 5-30 sec |
| 3 chars | 10-60 sec | 1-5 min |
| 4 chars | 2-10 min | 10-60 min |

## Security

- ✅ All addresses generated **locally** in containers
- ✅ Private keys **never transmitted** externally
- ✅ Results stored temporarily in Redis (1 hour TTL)
- ✅ Statistics logged locally in `vanity_addresses.jsonl`

## Roadmap

Check out our [ROADMAP.md](ROADMAP.md) for planned features:
- ✨ **v1.1.0** - Support for 6+ character vanity addresses
- 🌐 **v1.2.0** - Personal website to host your own vanity address service on your machine
- 🪙 **v2.0.0** - Custom vanity token address deployment on PumpFun

## Troubleshooting

### Bot not responding to commands

```bash
# Check bot is running
docker ps | grep solana-vanity-bot

# View logs
docker logs solana-vanity-bot

# Restart bot
docker restart solana-vanity-bot
```

### Redis connection issues

```bash
# Check Redis is running
docker ps | grep redis

# View Redis logs
docker logs redis

# Test Redis connection
docker exec redis redis-cli ping
```

### Generation timeouts

- Increase `maxWaitMs` in `handleGeneration` function
- Check CPU/memory availability
- Reduce other concurrent workloads

## Development

### Local Setup (without Docker)

```bash
# Install Node dependencies
npm install

# Install Python dependencies
pip install solders

# Start Redis locally
redis-server

# Run bot (set TELEGRAM_BOT_TOKEN first)
node vanity-bot.js
```

### Debugging

Enable verbose logging:
```bash
docker logs -f solana-vanity-bot | grep -i "info\|error\|job"
```

## Support & Contact

For issues, questions, or feature requests:

1. **🎯 Telegram Direct**: [@WhaleProfessor](https://t.me/WhaleProfessor) - Quick support & feature requests
2. **📋 GitHub Issues**: [Open an issue](https://github.com/whale-professor/Solvan/issues) - Bug reports
3. **📊 Logs**: Check `docker logs solana-vanity-bot` for debugging

## License

MIT License - See LICENSE file for details

## Disclaimer

⚠️ **IMPORTANT**: This tool generates real Solana addresses with valid private keys. Keep private keys secure and never share them. Use at your own risk.

---

Built with ❤️ for the Solana community

**Contact me**: [Telegram @WhaleProfessor](https://t.me/WhaleProfessor)
