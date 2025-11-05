from discord.ext import tasks, commands
import aiohttp
import os

class pushstatus(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.heartbeat_url = "https://bot-status-fetch.spacey.workers.dev/heartbeat"
        self.auth_token = os.getenv('PUSHTOKEN')
        self.pushstatus.start()
    
    @tasks.loop(seconds=60)
    async def pushstatus(self):
        """Send heartbeat with Discord API ping data"""
        ping_ms = round(self.bot.latency * 1000)
        
        async with aiohttp.ClientSession() as session:
            headers = {
                "Authorization": f"Bearer {self.auth_token}",
                "Content-Type": "application/json"
            }
            payload = {"ping": ping_ms}
            
            await session.post(
                self.heartbeat_url,
                headers=headers,
                json=payload
            )
    
    @pushstatus.before_loop
    async def before_pushstatus(self):
        """Wait for bot to be ready before starting"""
        await self.bot.wait_until_ready()

def setup(bot):
    bot.add_cog(pushstatus(bot))
