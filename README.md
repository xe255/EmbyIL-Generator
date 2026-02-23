# embyIL - Telegram Bot + Admin Dashboard

Unified application for managing Emby trial accounts through a Telegram bot with an admin dashboard.

## Features

- 🤖 Telegram bot for automated account creation
- 📊 Real-time admin dashboard
- 🔄 WebSocket support for live updates
- 📱 Mobile-friendly interface
- 🛡️ Account limits and expiration tracking
- 📨 Automatic expiration notifications

## Prerequisites

- Node.js (v14 or higher)
- npm or yarn
- A Telegram Bot Token (from [@BotFather](https://t.me/botfather))

## Installation

1. Clone the repository:
```bash
git clone <your-repo-url>
cd embyil
```

2. Install dependencies:
```bash
npm install
```

3. Set up environment variables:
   - Copy `.env.example` to `.env`
   - Edit `.env` and add your configuration:
   ```
   TELEGRAM_BOT_TOKEN=your_bot_token_here
   ADMIN_CHAT_ID=your_telegram_user_id
   PORT=3000
   ```

4. Initialize the database:
   - Copy `db.json.example` to `db.json` (or it will be created automatically on first run)

## Configuration

### Getting Your Telegram Bot Token

1. Message [@BotFather](https://t.me/botfather) on Telegram
2. Send `/newbot` and follow the instructions
3. Copy the token provided
4. Add it to your `.env` file

### Getting Your Admin Chat ID

1. Message [@userinfobot](https://t.me/userinfobot) on Telegram
2. Copy your user ID
3. Add it to your `.env` file as `ADMIN_CHAT_ID`

### Required group (users must join to use the bot)

1. Create or use a Telegram group and add your bot to the group.
2. In the group, send `/getgroupid` (as the admin). The bot will reply with the group ID.
3. **In your production `.env`** set `REQUIRED_GROUP_ID` to that ID and `REQUIRED_GROUP_INVITE` to your group invite link (e.g. `https://t.me/+F7ywFh8iVpVjODBk`).
4. Restart the bot. **If `REQUIRED_GROUP_ID` is not set, the group check is skipped** and anyone can use the bot. When set, every non-admin command and button checks group membership; users not in the group are asked to join and cannot use the bot until they do.

## Running the Application

### Option 1: Using start.bat (Windows)
Simply double-click `start.bat`

### Option 2: Manual Start
```bash
npm install
node app.js
```

The application will be available at:
- Admin Dashboard: http://localhost:3000
- Bot: Active on Telegram

## Project Structure

```
embyil/
├── app.js              # Main application (bot + dashboard)
├── bot.js              # Standalone bot option
├── database.js         # Database operations
├── utils.js            # Utility functions
├── tinyhost.js         # Temp mail API wrapper
├── public/             # Static files for dashboard
│   └── index.html      # Dashboard UI
├── embyil/             # Core automation logic
│   ├── index.js        # Automation script
│   └── tinyhost.js     # Temp mail API
├── .env                # Environment variables (DO NOT COMMIT)
├── .env.example        # Example environment file
├── .gitignore          # Git ignore rules
├── db.json             # Database file (DO NOT COMMIT)
├── db.json.example     # Database template
├── package.json        # Dependencies
├── start.bat           # Windows startup script
└── welcome_image.jpg   # Welcome image for bot
```

## Security Notes

⚠️ **IMPORTANT**: Never commit these files to Git:
- `.env` - Contains your bot token and secrets
- `db.json` - Contains user data and account information
- `node_modules/` - Third-party packages

These are already excluded in `.gitignore`.

## Environment Variables

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `TELEGRAM_BOT_TOKEN` | Your Telegram bot token | Yes | - |
| `ADMIN_CHAT_ID` | Your Telegram user ID | Yes | - |
| `PORT` | Server port | No | 3000 |
| `MAX_ACCOUNTS_PER_USER` | Maximum accounts per user | No | 3 |
| `TRIAL_DURATION_DAYS` | Trial period in days | No | 3 |

## Admin Dashboard Features

- 📊 Real-time user activity monitoring
- 💬 Direct messaging to users
- 📋 Account creation tracking
- 📈 Statistics and analytics
- 🔍 User search and filtering

## Bot Commands

### User Commands
- `/start` - Start the bot and view welcome message
- `/help` - Show help message with all available commands
- `/getid` - Get your Telegram Chat ID

### Admin Commands
- `/admin` - Open admin panel with buttons
- `/stats` - View system statistics
- `/users` - List all users with details
- `/blacklist` - View and manage blacklisted users
- `/accounts` - View all accounts statistics
- `/broadcast` - Send message to all users

**Note:** Admin commands require `ADMIN_CHAT_ID` to be set in environment variables.

## Troubleshooting

### Bot not responding
- Check that your `TELEGRAM_BOT_TOKEN` is correct in `.env`
- Make sure the bot is running (`node app.js`)
- Verify no firewall is blocking the connection

### Dashboard not loading
- Check that the port (default 3000) is not in use
- Navigate to `http://localhost:3000`
- Check browser console for errors

### Database errors
- Ensure `db.json` exists (or copy from `db.json.example`)
- Check file permissions
- Verify JSON syntax is valid

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

ISC

## Support

For issues or questions, please open an issue on GitHub.

---

**⚠️ Security Reminder**: Always keep your `.env` file and `db.json` secure and never share them publicly.
