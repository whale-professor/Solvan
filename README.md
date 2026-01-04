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
```bash
cp .env.example .env
# Edit .env and add your TELEGRAM_BOT_TOKEN
nano .env
```

3. Build the Docker images:
```bash
docker-compose build
```

4. Start the services:
```bash
docker-compose up -d
```

5. Check logs to verify it's running:
```bash
docker logs -f solana-vanity-bot
```

You should see:
```
✅ Bot token loaded
✅ Redis connected
✅ Bot is POLLING - waiting for messages...
✅ /info and /stats commands should now work!
```

## Usage

Start the bot on Telegram (find your bot by searching for it or via the link from [@BotFather](https://t.me/botfather)):

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
├── .env.example              # Environment template (copy to .env)
├── package.json              # Node dependencies
├── README.md                 # This file
├── ROADMAP.md               # Future features & plans
├── LICENSE                  # MIT license
└── .gitignore              # Git ignore rules
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `TELEGRAM_BOT_TOKEN` | Your Telegram bot token (from @BotFather) | Required |
| `REDIS_HOST` | Redis server hostname | `redis` |
| `REDIS_PORT` | Redis server port | `6379` |

Get your bot token:
1. Message [@BotFather](https://t.me/botfather) on Telegram
2. Use `/newbot` command
3. Follow the instructions
4. Copy your token to `.env` file

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
# 1. Check if containers are running
docker ps

# 2. View logs for errors
docker logs solana-vanity-bot

# 3. Verify bot token in .env
grep TELEGRAM_BOT_TOKEN .env

# 4. Restart the bot
docker-compose restart solana-vanity-bot
```

### Redis connection errors

```bash
# Check Redis status
docker logs redis

# Verify Redis is running
docker exec redis redis-cli ping

# Restart Redis
docker-compose restart redis
```

### Generation timeouts

- Increase timeout in `vanity-bot.js` (~line 155)
- Check system CPU/memory: `docker stats`
- Reduce concurrent workers

### Build issues

```bash
# Clean rebuild
docker-compose down
docker-compose build --no-cache
docker-compose up -d
```

## Development

### Local Setup (without Docker)

```bash
# Install Node dependencies
npm install

# Install Python dependencies
pip install solders

# Start Redis locally
redis-server

# Set environment variable
export TELEGRAM_BOT_TOKEN=your_token_here

# Run bot
node vanity-bot.js
```

### Debugging

Enable verbose logging:
```bash
docker logs -f solana-vanity-bot | grep -i "info\|error\|job\|user"
```

Monitor Redis:
```bash
docker exec -it redis redis-cli MONITOR
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
