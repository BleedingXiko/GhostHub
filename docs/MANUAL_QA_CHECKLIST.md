# GhostHub Manual QA Checklist
**For Raspberry Pi 4**

Run this checklist on actual Pi hardware before publishing or announcing a release.

---

## Pre-Test Setup
- [ ] Fresh Pi boot
- [ ] HDMI display connected
- [ ] Upstream network connected by Ethernet, or GhostHub access point active
- [ ] Media files present (at least 10 videos, 10 images)

---

## 1. Boot & Startup (5 mins)

### System Start
- [ ] Pi boots successfully
- [ ] GhostHub auto-starts
- [ ] UI appears on HDMI display
- [ ] No error messages on screen
- [ ] Boot time < 2 minutes

### Initial State
- [ ] Home page loads
- [ ] Categories are visible
- [ ] UI is responsive (not frozen)
- [ ] Network indicator shows connected

---

## 2. Video Playback (10 mins)

### Basic Playback
- [ ] Click a category → media list appears
- [ ] Click a video → video loads
- [ ] Video plays smoothly (no stuttering)
- [ ] Audio works correctly
- [ ] Video controls respond (pause/play)

### Navigation
- [ ] Arrow keys navigate between videos
- [ ] Swipe/touch navigation works (if touchscreen)
- [ ] Back button returns to categories
- [ ] Progress bar shows correctly
- [ ] Seeking (fast forward/rewind) works

### Stress Test
- [ ] Play video for 30 minutes continuously
- [ ] No crashes or freezes
- [ ] No memory warnings
- [ ] Temperature stays reasonable (< 80°C)

### Different Formats
- [ ] MP4 videos play
- [ ] MKV videos play (with transcoding)
- [ ] AVI videos play (with transcoding)
- [ ] Subtitles load if available
- [ ] Thumbnails generate correctly

---

## 3. Image Gallery (5 mins)

### Image Viewing
- [ ] Click image category → images load
- [ ] Click image → full view opens
- [ ] Image quality is good (not pixelated)
- [ ] Navigation between images works

### Performance
- [ ] 10k+ indexed media library opens without loading an entire category/month into memory
- [ ] Streaming rows, gallery timeline, month overlay, and search share hydrated records through `window.ragotModules.mediaManifest`
- [ ] Visible-window navigation hydrates only missing ids through `/api/media/records`
- [ ] Thumbnails load progressively (lazy loading)
- [ ] No memory issues with large galleries

---

## 4. Admin Panel (15 mins)

### Access
- [ ] Settings/admin button visible
- [ ] Click opens admin panel
- [ ] Panel displays correctly
- [ ] No layout issues

### Settings Management
- [ ] Change a setting (e.g., subtitle toggle)
- [ ] Click Save
- [ ] Setting actually persists (refresh page, check)
- [ ] Invalid values show error messages

### User Management
- [ ] Add new user
- [ ] User appears in list
- [ ] Edit user details
- [ ] Delete user
- [ ] Changes persist after reboot

### File Management
- [ ] Upload a video file (100+ MB)
- [ ] Upload completes successfully
- [ ] Thumbnail generates automatically
- [ ] Video appears in media list
- [ ] File can be played immediately

### Network Settings (CRITICAL)
- [ ] Access point settings display
- [ ] Change access point network name/password/channel
- [ ] Connection succeeds
- [ ] Settings persist after reboot

---

## 5. Sync Mode (if enabled) (10 mins)

### TV Mode
- [ ] Enable sync/TV mode
- [ ] Share code appears
- [ ] Other device can connect
- [ ] Playback syncs between devices
- [ ] No lag or desync issues

### Multi-User
- [ ] Multiple users can join
- [ ] All see same video
- [ ] Authority user controls playback
- [ ] Disconnect works cleanly

---

## 6. Error Handling (10 mins)

### Network Issues
- [ ] Disconnect network
- [ ] App shows error gracefully (no crash)
- [ ] Reconnect network
- [ ] App recovers automatically

### Corrupted Files
- [ ] Add corrupted video file
- [ ] App doesn't crash when loading it
- [ ] Shows error message
- [ ] Can navigate to other videos

### Full Storage
- [ ] Fill storage to 95%+
- [ ] Upload attempt shows clear error
- [ ] Doesn't crash the app
- [ ] Shows remaining space

### Power Loss
- [ ] Unplug Pi during playback
- [ ] Plug back in and boot
- [ ] No database corruption
- [ ] Settings preserved
- [ ] Can resume playback

---

## 7. Performance (15 mins)

### Resource Usage
- [ ] Check CPU usage: `htop` (should be < 80%)
- [ ] Check memory: `free -h` (should have 500MB+ free)
- [ ] Check temperature: `vcgencmd measure_temp` (< 80°C)

### Long Session
- [ ] Use app continuously for 2 hours
- [ ] Play multiple videos
- [ ] Navigate extensively
- [ ] Check for memory leaks (memory usage stable)
- [ ] No slowdown over time

### Large Library
- [ ] Test with 500+ files
- [ ] Categories load in < 5 seconds
- [ ] Media list scrolls smoothly
- [ ] Search/filter works quickly

---

## 8. UI/UX (5 mins)

### Visual Quality
- [ ] UI looks professional (not broken)
- [ ] Text is readable
- [ ] Buttons are clickable (not too small)
- [ ] Colors/contrast are good
- [ ] No weird layout issues

### Responsiveness
- [ ] Clicks respond immediately (< 200ms)
- [ ] No laggy animations
- [ ] UI doesn't freeze
- [ ] Loading indicators show when needed

---

## 9. Special Features (5 mins)

### Auto-Play
- [ ] Enable auto-play
- [ ] Videos advance automatically
- [ ] Interval setting works
- [ ] Can stop auto-play

### Progress Tracking
- [ ] Play video halfway
- [ ] Exit and return
- [ ] Video resumes at correct position
- [ ] Progress saves across reboots

### Chat (if enabled)
- [ ] Open chat
- [ ] Send message
- [ ] Message appears
- [ ] Commands work (!play, !next, etc.)

---

## 10. HDMI & Display (5 mins)

### Display Settings
- [ ] HDMI output works on boot
- [ ] 1080p resolution correct
- [ ] 4K works (if supported)
- [ ] Switching HDMI input/output works
- [ ] No screen flickering

### Audio Output
- [ ] HDMI audio works
- [ ] Volume controls work
- [ ] No audio crackling/distortion
- [ ] Audio sync with video

---

## Critical Failures (Release Blockers)

If any of these fail, do not publish release assets until the issue is understood and fixed:

- [ ] ❌ App crashes during normal use
- [ ] ❌ Videos don't play at all
- [ ] ❌ Admin panel doesn't save settings
- [ ] ❌ File uploads fail completely
- [ ] ❌ Access point settings don't persist
- [ ] ❌ Pi overheats (> 85°C)
- [ ] ❌ Memory leak (runs out of RAM)
- [ ] ❌ Corrupted files crash the app
- [ ] ❌ Power loss corrupts database

---

## Minor Issues (Fix if time allows)

- [ ] ⚠️ Slow thumbnail generation (> 10s)
- [ ] ⚠️ UI layout quirks
- [ ] ⚠️ Missing error messages
- [ ] ⚠️ Non-critical features broken

---

## Sign-Off

**Tester:** ________________
**Date:** ________________
**Pi Model:** Raspberry Pi 4
**OS Version:** ________________
**GhostHub Version:** ________________

**Overall Assessment:**
- [ ] PASS - Ready for release
- [ ] CONDITIONAL - Minor issues documented
- [ ] FAIL - Critical issues remain

**Notes:**
```
[Add any issues found, workarounds, or concerns]
```

---

## Post-Release Follow-Up

After release:
- [ ] Monitor for crash reports
- [ ] Collect user feedback
- [ ] Check Pi temperature reports
- [ ] Monitor file upload success rate
- [ ] Track video playback errors

**Maintainer/contact:** ________________
