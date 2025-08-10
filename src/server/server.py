import os
import dotenv
import aiohttp
from sanic import Sanic, response
from sanic.request import Request
from web3 import Web3
from cdp import CdpClient, parse_units
from cdp.evm_transaction_types import TransactionRequestEIP1559
from cdp.auth.utils.jwt import generate_jwt, JwtOptions

# Load environment variables
dotenv.load_dotenv()

# --- Configuration ---
APP_NAME = "ServerWallets"
WALLET_NAME = "p2d-wallet"
NETWORK = "base-sepolia"
USDC_CONTRACT = Web3.to_checksum_address("0x036CbD53842c5426634e7929541eC2318f3dCF7e")
USDC_DECIMALS = 6
ETH_DECIMALS = 18
FAUCET_EXPLORER_URL = "https://sepolia.basescan.org/tx/{}"
WEB3_PROVIDER = "https://sepolia.base.org"

# Test address for JWT validation
TEST_ADDRESS = "0x153fc43c88d96c27a9ca15a429ea4cff2aa1c81d"

# Reward amounts
ETH_REWARD_AMOUNT = 0.00001  # 0.00001 ETH for new users
USDC_REWARD_AMOUNT = 0.01  # 0.01 USDC for users with ETH

# Coinbase Platform API configuration
CDP_PLATFORM_BASE_URL = "https://api.cdp.coinbase.com/platform/v2"

# JWT credentials for Platform API
CDP_PLATFORM_KEY_NAME = os.getenv("CDP_PLATFORM_KEY_NAME")  # Your API key name
CDP_PLATFORM_KEY_SECRET = os.getenv("CDP_PLATFORM_KEY_SECRET")  # Your API key secret

# --- Initialize App & CDP Client ---
app = Sanic(APP_NAME)
cdp = CdpClient(
    api_key_id=os.getenv("CDP_API_KEY_ID"),
    api_key_secret=os.getenv("CDP_API_KEY_SECRET"),
    wallet_secret=os.getenv("CDP_WALLET_SECRET"),
)

# --- Helpers ---
async def get_or_create_wallet():
    """Get or create an EVM wallet."""
    return await cdp.evm.get_or_create_account(name=WALLET_NAME)

def encode_erc20_transfer(to: str, amount_units: int) -> str:
    """Encode ERC20 transfer data."""
    return (
        "0xa9059cbb"
        + Web3.to_checksum_address(to)[2:].zfill(64)
        + hex(amount_units)[2:].zfill(64)
    )

async def send_usdc(wallet_addr: str, to_addr: str, amount: float) -> str:
    """Send USDC using the CDP API."""
    amount_units = int(amount * 10**USDC_DECIMALS)
    transfer_data = encode_erc20_transfer(to_addr, amount_units)

    return await cdp.evm.send_transaction(
        address=wallet_addr,
        transaction=TransactionRequestEIP1559(
            to=USDC_CONTRACT,
            data=transfer_data,
            value=0,
        ),
        network=NETWORK,
    )

async def send_eth(wallet_addr: str, to_addr: str, amount: float) -> str:
    """Send ETH using the CDP API."""
    amount_wei = int(amount * 10**ETH_DECIMALS)

    return await cdp.evm.send_transaction(
        address=wallet_addr,
        transaction=TransactionRequestEIP1559(
            to=to_addr,
            value=amount_wei,
        ),
        network=NETWORK,
    )

def generate_platform_jwt(network: str, address: str) -> str:
    """Generate JWT token for Coinbase Platform API."""
    try:
        # Map network name for Platform API
        network_mapping = {
            "base-sepolia": "base-sepolia"
        }
        platform_network = network_mapping.get(network, network)
        
        jwt_token = generate_jwt(JwtOptions(
            api_key_id=CDP_PLATFORM_KEY_NAME,
            api_key_secret=CDP_PLATFORM_KEY_SECRET,
            request_method="GET",
            request_host="api.cdp.coinbase.com",
            request_path=f"/platform/v2/evm/token-balances/{platform_network}/{address}",
            expires_in=120  # 120 seconds (2 minutes)
        ))
        return jwt_token
    except Exception as e:
        print(f"Error generating JWT token: {e}")
        raise e

async def test_jwt_authentication(test_address: str = TEST_ADDRESS) -> bool:
    """Test JWT authentication by fetching token balances for a test address."""
    try:
        print(f"=== Testing JWT Authentication ===")
        print(f"Test address: {test_address}")
        print(f"CDP Platform Key Name: {CDP_PLATFORM_KEY_NAME}")
        
        # Generate JWT token with proper parameters
        jwt_token = generate_platform_jwt(NETWORK, test_address)
        print(f"Generated JWT token (first 50 chars): {jwt_token[:50]}...")
        
        # Map network name for Platform API
        network_mapping = {
            "base-sepolia": "base-sepolia"
        }
        platform_network = network_mapping.get(NETWORK, NETWORK)
        
        url = f"{CDP_PLATFORM_BASE_URL}/evm/token-balances/{platform_network}/{test_address}"
        headers = {
            "Authorization": f"Bearer {jwt_token}",
            "Content-Type": "application/json"
        }
        
        print(f"Making request to: {url}")
        
        async with aiohttp.ClientSession() as session:
            async with session.get(url, headers=headers) as resp:
                print(f"Response status: {resp.status}")
                
                if resp.status == 200:
                    data = await resp.json()
                    print(f"✅ JWT Authentication successful!")
                    print(f"Response data: {data}")
                    
                    # Display balance information
                    balances = data.get("data", [])
                    if balances:
                        print(f"Found {len(balances)} token balance(s):")
                        for balance in balances:
                            symbol = balance.get("symbol", "Unknown")
                            balance_value = balance.get("balance", "0")
                            decimals = int(balance.get("decimals", 0))
                            contract_address = balance.get("contract_address", "Native")
                            
                            # Convert balance to human readable format
                            if decimals > 0:
                                readable_balance = float(balance_value) / (10 ** decimals)
                                print(f"  - {symbol}: {readable_balance} (Contract: {contract_address})")
                            else:
                                print(f"  - {symbol}: {balance_value} (Contract: {contract_address})")
                    else:
                        print("  No token balances found for this address")
                    
                    return True
                else:
                    error_text = await resp.text()
                    print(f"❌ JWT Authentication failed!")
                    print(f"Error: {resp.status} - {error_text}")
                    return False
                    
    except Exception as e:
        print(f"❌ JWT test failed with exception: {e}")
        return False

async def check_eth_balance(address: str) -> float:
    """Check ETH balance using Coinbase Platform API with JWT authentication."""
    try:
        # Map network name for Platform API
        network_mapping = {
            "base-sepolia": "base-sepolia"  # Adjust if needed
        }
        platform_network = network_mapping.get(NETWORK, NETWORK)
        
        # Generate fresh JWT token for this request with proper parameters
        jwt_token = generate_platform_jwt(NETWORK, address)
        
        url = f"{CDP_PLATFORM_BASE_URL}/evm/token-balances/{platform_network}/{address}"
        headers = {
            "Authorization": f"Bearer {jwt_token}",
            "Content-Type": "application/json"
        }
        
        print(f"Checking balance for {address} on {platform_network}")
        
        async with aiohttp.ClientSession() as session:
            async with session.get(url, headers=headers) as resp:
                if resp.status != 200:
                    error_text = await resp.text()
                    print(f"Failed to get balance: {resp.status} - {error_text}")
                    return 0.0
                
                data = await resp.json()
                print(f"Balance API response: {data}")
                
                # Look for ETH balance in the NEW response format
                balances = data.get("balances", [])  # Changed from "data" to "balances"
                
                for balance in balances:
                    token = balance.get("token", {})
                    amount = balance.get("amount", {})
                    
                    # Check if this is ETH - look for ETH symbol and the special contract address
                    if (token.get("symbol", "").upper() == "ETH" and 
                        token.get("contractAddress") == "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"):
                        
                        balance_amount = amount.get("amount", "0")
                        decimals = int(amount.get("decimals", 18))
                        
                        # Convert from wei to ETH
                        eth_balance = float(balance_amount) / (10 ** decimals)
                        print(f"Found ETH balance for {address}: {eth_balance}")
                        return eth_balance
                
                print(f"No ETH balance found for {address}")
                return 0.0
                
    except Exception as e:
        print(f"Error checking ETH balance for {address}: {e}")
        return 0.0

# --- Startup: Faucet & Test Transaction ---
@app.before_server_start
async def init_wallet(_app, _loop):
    # print("=== JWT Setup ===")
    # # Test JWT authentication first
    # jwt_success = await test_jwt_authentication()
    # if not jwt_success:
    #     print("⚠️  JWT authentication test failed - continuing with wallet setup anyway")
    # else:
    #     print("✅ JWT authentication test passed")
    
    print("\n=== Wallet Setup ===")
    wallet = await get_or_create_wallet()
    print(f"Wallet address: {wallet.address}")

    # try:
    #     # Request faucet funds for both ETH and USDC
    #     print("Requesting ETH faucet...")
    #     eth_faucet_tx = await cdp.evm.request_faucet(
    #         address=wallet.address,
    #         network=NETWORK,
    #         token="eth",
    #     )
    #     print(f"Requested ETH faucet: {FAUCET_EXPLORER_URL.format(eth_faucet_tx)}")

    #     print("Requesting USDC faucet...")
    #     usdc_faucet_tx = await cdp.evm.request_faucet(
    #         address=wallet.address,
    #         network=NETWORK,
    #         token="usdc",
    #     )
    #     print(f"Requested USDC faucet: {FAUCET_EXPLORER_URL.format(usdc_faucet_tx)}")

    #     # Wait for faucet confirmations
    #     web3 = Web3(Web3.HTTPProvider(WEB3_PROVIDER))
    #     web3.eth.wait_for_transaction_receipt(eth_faucet_tx)
    #     web3.eth.wait_for_transaction_receipt(usdc_faucet_tx)

    #     print("Faucet transactions confirmed")

    # except Exception as e:
    #     print(f"Faucet setup failed: {e}")
    

# --- API Routes ---
@app.post("/send")
async def send_reward_route(request: Request):
    """Send appropriate reward based on user's ETH balance."""
    data = request.json or {}
    to_addr = data.get("to")

    # Input validation
    if not to_addr:
        return response.json({"error": "Missing `to` address"}, status=400)

    try:
        wallet = await get_or_create_wallet()
        
        # Check user's ETH balance
        eth_balance = await check_eth_balance(to_addr)
        print(f"User {to_addr} has ETH balance: {eth_balance}")
        
        # Decide reward type based on ETH balance
        if eth_balance == 0.0:
            # User has no ETH, send ETH reward
            print(f"Sending {ETH_REWARD_AMOUNT} ETH to {to_addr} (new user)")
            
            tx_hash = await send_eth(wallet.address, to_addr, ETH_REWARD_AMOUNT)
            
            return response.json({
                "status": "completed",
                "transaction_hash": tx_hash,
                "reward_type": "ETH",
                "amount": f"{ETH_REWARD_AMOUNT}",
                "reason": "new_user"
            })
        else:
            # User has ETH, send USDC reward
            print(f"Sending {USDC_REWARD_AMOUNT} USDC to {to_addr} (existing user)")
            
            tx_hash = await send_usdc(wallet.address, to_addr, USDC_REWARD_AMOUNT)
            
            return response.json({
                "status": "completed",
                "transaction_hash": tx_hash,
                "reward_type": "USDC",
                "amount": f"{USDC_REWARD_AMOUNT}",
                "reason": "existing_user"
            })

    except Exception as e:
        print(f"Error sending reward: {e}")
        return response.json({"error": f"Failed to send reward: {e}"}, status=500)

# --- Main ---
if __name__ == "__main__":
    app.run(
        host="0.0.0.0",
        port=3003,
        workers=1,
        fast=False,
        access_log=True,
        single_process=True,
    )