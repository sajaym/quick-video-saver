// Human explanations for the failure codes produced by the helper.
const TABLE = {
  gone: ['This link has expired or was removed', 'Reload the video page, press play, then try again. Streaming links usually expire within minutes.', 'reload'],
  forbidden: ['The website refused the download', 'Stay logged in on the site and try again from the open page. The extension already reuses your login and browser identity.', 'reload'],
  auth: ['This video needs you to sign in', 'Log in on the website in this browser, reload the page and try again.', 'reload'],
  login_required: ['Sign-in or membership required', 'Log in on the website in this browser (and finish any age or bot check), then try again.', 'reload'],
  geo: ['Not available in your region', 'The website blocks videos in your location.', ''],
  rate_limited: ['The website is limiting requests', 'Wait a few minutes before trying again.', ''],
  drm: ['This video is DRM-protected', 'Encrypted streaming (Widevine, PlayReady, FairPlay) cannot be saved by any downloader.', ''],
  network: ['Network problem', 'Check your internet connection and try again.', 'retry'],
  extractor: ['The site changed and the downloader is out of date', 'Open Settings and press “Update downloader”, then retry.', 'update'],
  unsupported: ['No downloadable video found here', 'Play the video first so it can be detected, or use the stream shown in the list.', ''],
  not_media: ['The server sent a web page instead of a video', 'The link probably expired or needs a login. Reload the page, play the video and try again.', 'reload'],
  postprocess: ['Could not combine audio and video', 'Try another quality, or switch the container to MKV in Settings.', 'retry'],
  disk_full: ['Your disk is full', 'Free some space or choose another download folder in Settings.', ''],
  permission: ['Windows blocked writing to the folder', 'Choose a different download folder in Settings.', ''],
  tool_missing: ['Helper files are missing', 'Run SETUP-WINDOWS.cmd again from the extension package.', ''],
  scheduled: ['The live stream has not started yet', 'Try again when the stream is live.', 'retry'],
  unknown: ['The download failed', 'Try again. If it keeps failing, copy the details and check them.', 'retry'],
};

export function describeError(code, raw = '') {
  const [title, hint, action] = TABLE[code] || TABLE.unknown;
  return {title, hint, action, detail: String(raw || '').slice(0, 400)};
}
