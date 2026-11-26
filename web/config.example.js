// Copy to config.js (the GitHub Pages workflow writes it for you from repository variables).
// These values are public by design: the publishable key only works together with
// the database's row-level security, and the VAPID key is the *public* half.
window.LEDGER_CONFIG = {
  supabaseUrl: 'https://YOUR-PROJECT-REF.supabase.co',
  supabaseKey: 'sb_publishable_...',
  vapidPublicKey: 'B...',
};
