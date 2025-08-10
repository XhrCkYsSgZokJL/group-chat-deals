# DealFlow 🔥

**Upgrade your group chat into an economy.**

Turn any Base group chat into a marketplace with built-in rewards. Tag @deal with a description to instantly create product listings, and earn crypto for community participation. Built for Hopscotch.trade Store owners.

## 🚀 How It Works

**Create Listings:**
1. **Tag & Describe:** @deal Vintage sneakers, size 10, great condition
2. **AI Processing:** Bot generates listing with image, title, pricing
3. **Social Approval:** Creator + 1 other person approve with 👍
4. **Instant Publishing:** Live on Hopscotch.trade marketplace

**Earn Rewards:**
- **New Users:** Get testnet ETH for your first approval
- **Active Members:** Earn testnet USDC for continued participation
- **Smart Distribution:** Bot checks your wallet and sends appropriate tokens

## 🛠️ Tech Stack

### Core Infrastructure
- **XMTP Protocol:** Decentralized messaging on Base
- **OpenAI GPT + DALL-E:** AI listing generation and image creation
- **TypeScript/Node.js:** Core bot infrastructure
- **AWS S3:** File storage and delivery
- **Base Network:** L2 Ethereum integration

### Coinbase Integration
- **Server Wallets API:** Programmatic token distribution
- **Data API:** Real-time wallet balance checking
- **JWT Authentication:** Secure API access
- **Smart Rewards:** Context-aware token distribution

## ✨ Features

### Marketplace Creation
- **AI-Generated Listings:** Automatic titles, descriptions, and images
- **Reply Chain Context:** Gathers info from conversation threads
- **Emoji Reactions:** 👍 to approve publishing
- **Image Support:** Upload photos or let AI generate them
- **Instant Marketplace:** Direct integration with Hopscotch.trade

### Community Rewards
- **Participation Incentives:** Earn crypto for thumbs-up reactions
- **Smart Token Distribution:**
  - New users (0 ETH balance) → Receive testnet ETH
  - Existing users (has ETH) → Receive testnet USDC
- **Real-time Balance Checking:** Uses Coinbase Data API
- **Automated Payouts:** Immediate reward distribution

## 🚦 Quick Start

1. **Setup Requirements:**
   - Hopscotch.trade Store account
   - Base-compatible wallet
   - Group chat (not available in DMs)

2. **Add the Bot:**
   - Add `deal.hopscotch.eth` to your Base group chat

3. **Start Creating & Earning:**
   - Tag @deal with product descriptions
   - Approve deals with 👍 to earn rewards
   - Watch your marketplace grow

## 🔒 Technical Requirements

### For Store Owners
- Active Hopscotch.trade Store account
- Base network wallet connection
- XMTP-compatible wallet for group messaging

### For Developers
- Coinbase Developer Platform access
- Environment variables for API keys:
  ```
  CDP_API_KEY_ID=your_api_key_id
  CDP_API_KEY_SECRET=your_api_key_secret
  CDP_WALLET_SECRET=your_wallet_secret
  CDP_PLATFORM_KEY_NAME=your_platform_key
  CDP_PLATFORM_KEY_SECRET=your_platform_secret
  ```

## 💰 Reward System

### Token Distribution Logic
```
User Balance Check → Reward Decision
├── 0 ETH Balance → Send 0.00001 testnet ETH (onboarding)
└── Has ETH Balance → Send 0.01 testnet USDC (engagement)
```

### Supported Networks
- **Primary:** Base Sepolia (testnet)
- **Tokens:** ETH, USDC
- **Future:** Mainnet Base integration planned

## 🌟 Why DealFlow?

**For Communities:**
- Transform passive group chats into active marketplaces
- Reward engagement with real crypto incentives
- Create sustainable micro-economies

**For Creators:**
- AI-powered listing generation saves time
- Built-in approval system ensures quality
- Direct integration with established marketplace

**For Users:**
- Earn while you participate
- No complex setup or manual claiming
- Smart reward system adapts to your activity level

---

**Ready to monetize your community?**

DealFlow - Where conversation meets commerce, and participation pays.

*Built on Base • Powered by AI • Rewarded with Crypto*
