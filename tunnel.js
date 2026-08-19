import localtunnel from 'localtunnel';

const startTunnel = async () => {
  try {
    const tunnel = await localtunnel({ port: 5000, subdomain: 'abhinash-twilio-test' });
    console.log(`\n\n========================================`);
    console.log(`[Tunnel] PERMANENT URL: ${tunnel.url}`);
    console.log(`========================================\n\n`);
    
    tunnel.on('close', () => {
      console.log('[Tunnel] Closed. Restarting in 2 seconds...');
      setTimeout(startTunnel, 2000);
    });
    
    tunnel.on('error', (err) => {
      console.error('[Tunnel] Error:', err);
    });
  } catch (err) {
    console.error('[Tunnel] Start error:', err);
    setTimeout(startTunnel, 2000);
  }
};

startTunnel();
