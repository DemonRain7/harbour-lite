const { canResume } = require('../../web/music-context');
// Small local controls can restore Folia, but cannot start another player or switch providers.
const ACTIONS = new Set(['pause', 'resume', 'previous', 'next', 'shuffle', 'set_playback_mode']);
function musicTransport(command, provider, state) {
  if (!command || !ACTIONS.has(command.action)) throw new Error('不支持的音乐快捷操作');
  if (command.action === 'resume') {
    if (provider !== 'folia' || !canResume(state)) throw new Error('Folia 当前不可用，请检查音乐模块');
    return { action: 'resume' };
  }
  if (command.action === 'set_playback_mode') {
    if (provider !== 'folia' || state?.connected === false || state?.running === false || state?.playbackModeAvailable !== true) throw new Error('当前播放器不支持切换播放模式');
    if (!['off', 'all', 'one', 'shuffle'].includes(command.playbackMode)) throw new Error('playbackMode 无效');
    return { action: command.action, playbackMode: command.playbackMode };
  }
  if (provider !== 'folia' || state?.connected === false || state?.running === false || state?.loaded !== true) {
    throw new Error('Folia 当前未在播放，请先在音乐页选择歌曲');
  }
  if (command.action === 'shuffle' && state.shuffleAvailable !== true) throw new Error('当前队列不能随机播放');
  return { action: command.action };
}
module.exports = { musicTransport };
