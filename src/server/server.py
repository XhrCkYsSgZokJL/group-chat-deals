import os
import dotenv
from sanic import Sanic, response
from sanic.request import Request
from web3 import Web3
from cdp import CdpClient, parse_units
from cdp.evm_transaction_types import TransactionRequestEIP1559

# Load environment variables
dotenv.load_dotenv()

# --- Configuration ---
APP_NAME = "ServerWallets"
WALLET_NAME = "p2d-wallet"
NETWORK = "base-sepolia"
USDC_CONTRACT = Web3.to_checksum_address("0x036CbD53842c5426634e7929541eC2318f3dCF7e")
USDC_DECIMALS = 6
FAUCET_EXPLORER_URL = "https://sepolia.basescan.org/tx/{}"
WEB3_PROVIDER = "https://sepolia.base.org"

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

# --- Startup: Faucet & Test Transaction ---
@app.before_server_start
async def init_wallet(_app, _loop):
    wallet = await get_or_create_wallet()
    print(f"Wallet address: {wallet.address}")

    try:
        # Request faucet funds
        faucet_tx = await cdp.evm.request_faucet(
            address=wallet.address,
            network=NETWORK,
            token="usdc",
        )
        print(f"Requested faucet: {FAUCET_EXPLORER_URL.format(faucet_tx)}")

        # Wait for faucet confirmation
        Web3(Web3.HTTPProvider(WEB3_PROVIDER)).eth.wait_for_transaction_receipt(faucet_tx)

        # # Send test transfer
        # test_tx = await send_usdc(
        #     wallet_addr=wallet.address,
        #     to_addr="0x153fc43c88d96c27a9ca15a429ea4cff2aa1c81d",
        #     amount=1.0,
        # )
        # print(f"Test USDC transfer completed: {test_tx}")

    except Exception as e:
        print(f"Test USDC transfer failed: {e}")

# --- API Routes ---
@app.post("/send")
async def send_usdc_route(request: Request):
    """Send USDC to a given address."""
    data = request.json or {}
    to_addr = data.get("to")
    amount_usdc = data.get("amount")

    # Input validation
    if not to_addr or amount_usdc is None:
        return response.json({"error": "Missing `to` or `amount`"}, status=400)
    try:
        amount_usdc = float(amount_usdc)
        if amount_usdc <= 0:
            raise ValueError("Amount must be positive")
    except ValueError as e:
        return response.json({"error": str(e)}, status=400)

    try:
        wallet = await get_or_create_wallet()
        print(f"Sending {amount_usdc} USDC to {to_addr}")

        tx_hash = await send_usdc(wallet.address, to_addr, amount_usdc)

        print(f"Transfer completed: {tx_hash}")
        return response.json({
            "status": "completed",
            "transaction_hash": tx_hash,
            "amount": f"{amount_usdc} USDC",
        })

    except Exception as e:
        print(f"Error sending USDC: {e}")
        return response.json({"error": f"Failed to send USDC: {e}"}, status=500)

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
