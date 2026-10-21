// This preload is registered only by isolated Folia tests, never by the app.
// Keep the real Folia preload and renderer intact; seed an ordinary preference.
if (location.protocol === 'file:') {
  if (!localStorage.getItem('folia_app_language')) localStorage.setItem('folia_app_language', 'zh-CN');
  // Native feature fixtures deliberately play into the player. The new first-choice dialog is
  // tested separately; it must not race unrelated workshop/window interactions after welcome.
  if (!localStorage.getItem('playback_entry_view_chosen')) {
    localStorage.setItem('playback_entry_view', 'player');
    localStorage.setItem('playback_entry_view_chosen', 'true');
  }
}
