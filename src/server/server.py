import os
from sanic import Sanic, response
from sanic.request import Request
from cdp import CdpClient
import dotenv

dotenv.load_dotenv()

app = Sanic("ServerWallets")

cdp = CdpClient(
    api_key_id=os.getenv("CDP_API_KEY_ID"),
    api_key_secret=os.getenv("CDP_API_KEY_SECRET"),
    wallet_secret=os.getenv("CDP_WALLET_SECRET"),
)

OWNER_NAME = "p2d-owner"
SMART_ACCOUNT_NAME = "p2d-smart"

async def find_smart_account_by_name(cdp, target_name):
    response = await cdp.evm.list_smart_accounts()

    while True:
        accounts = response[1] if isinstance(response, tuple) else response.accounts
        for account in accounts:
            if account.name == target_name:
                return account

        if getattr(response, 'next_page_token', None):
            response = await cdp.evm.list_smart_accounts(page_token=response.next_page_token)
        else:
            break
    return None


async def get_or_create_smart_account(cdp, name, owner):
    account = await find_smart_account_by_name(cdp, name)
    if account:
        return account

    try:
        return await cdp.evm.create_smart_account(name=name, owner=owner)
    except Exception as e:
        if "already_exists" in str(e):
            return await find_smart_account_by_name(cdp, name)
        raise


async def get_owner_evm_account():
    return await cdp.evm.get_or_create_account(name=OWNER_NAME)


async def get_smart_account(owner_account):
    return await get_or_create_smart_account(cdp, SMART_ACCOUNT_NAME, owner_account)


@app.before_server_start
async def init_wallet(app, _loop):
    owner = await get_owner_evm_account()
    smart_acct = await get_smart_account(owner)

    print(f"Smart account address (deterministic): {smart_acct.address}")

    testnet_token = "usdc" # eth

    faucet_response = await cdp.evm.request_faucet(
        address=smart_acct.address,
        network="base-sepolia",
        token=testnet_token
    )

    print(f"Requested funds from {testnet_token} faucet: https://sepolia.basescan.org/tx/{faucet_response}")


@app.post("/send")
async def send_eth(request: Request):
    data = request.json
    if not data or "to" not in data or "amount" not in data:
        return response.json({"error": "Missing `to` or `amount`"}, status=400)

    try:
        to_addr = data["to"]
        amount_eth = float(data["amount"])
        if amount_eth <= 0:
            raise ValueError("Amount must be positive")
    except Exception as e:
        return response.json({"error": str(e)}, status=400)

    owner = await get_owner_evm_account()
    smart_acct = await get_smart_account(owner)

    call = {"to": to_addr, "value": int(amount_eth * 1e18)}
    result = await cdp.evm.send_user_operation(
        smart_account=smart_acct,
        network="base-sepolia",
        calls=[call]
    )

    return response.json({"status": "submitted", "op": result})

if __name__ == "__main__":
    app.run(
        host="0.0.0.0", 
        port=3003, 
        workers=1, 
        fast=False, 
        access_log=True,
        single_process=True 
    )
