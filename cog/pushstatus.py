"""
Example discord.py cog that posts a heartbeat to Bot Status Worker every 60s.

Configuration (environment variables):
  PUSHSTATUS_URL  - full heartbeat URL, e.g. https://bot-status.<your-subdomain>.workers.dev/heartbeat
                    (use /<botname>/heartbeat for a named bot)
  PUSHTOKEN       - bearer token: AUTH_TOKEN for the default bot, or the bot's <botname>_auth secret
"""
import logging
import os

import aiohttp
from discord.ext import commands, tasks

log = logging.getLogger(__name__)


class pushstatus(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.heartbeat_url = os.getenv(
            "PUSHSTATUS_URL",
            "https://bot-status.<your-subdomain>.workers.dev/heartbeat",
        )
        self.auth_token = os.getenv("PUSHTOKEN")
        if not self.auth_token:
            log.warning("PUSHTOKEN is not set; heartbeats will be rejected with 401")
        self.pushstatus.start()

    def cog_unload(self):
        self.pushstatus.cancel()

    @tasks.loop(seconds=60)
    async def pushstatus(self):
        """Send heartbeat with Discord API ping data"""
        ping_ms = round(self.bot.latency * 1000)
        headers = {
            "Authorization": f"Bearer {self.auth_token}",
            "Content-Type": "application/json",
        }
        payload = {"ping": ping_ms}
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    self.heartbeat_url, headers=headers, json=payload, timeout=aiohttp.ClientTimeout(total=10)
                ) as resp:
                    if resp.status != 200:
                        log.warning("Heartbeat failed: HTTP %s", resp.status)
        except Exception as exc:  # network errors should never crash the bot
            log.warning("Heartbeat error: %s", exc)

    @pushstatus.before_loop
    async def before_pushstatus(self):
        """Wait for bot to be ready before starting"""
        await self.bot.wait_until_ready()


async def setup(bot):
    await bot.add_cog(pushstatus(bot))
