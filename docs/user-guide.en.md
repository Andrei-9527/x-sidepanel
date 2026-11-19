# User guide

[中文](使用说明.md) · [Install](../README.en.md)

@Andrei_9527 shows X in the Chrome side panel and keeps following and follower lists on this computer. It requires **Chrome 145+** and a network that can open [x.com](https://x.com). Install steps are in the [README](../README.en.md).

This tool is not affiliated with X. Read the risk notice at the end before using it with an important account.

## Open the side panel

Sign in at [x.com](https://x.com) in a normal tab first. Then open the panel either way:

- Click the extensions icon in the Chrome toolbar and choose **@Andrei_9527**
- Press `Alt+Shift+X`

The panel can be dragged wider or narrower. If the timeline does not appear, check that x.com is signed in and the network works in a normal tab, then click **Home** in the panel.

The labels below follow the side panel language. On a Chinese interface the same controls are **首页**, **粉丝管理**, and **立即同步**.

## Toolbar

From left to right:

| Control | What it does |
| --- | --- |
| Home | Opens the X home timeline |
| Followers | Opens the following and follower page stored on this computer. Zoom is hidden on this page |
| − / percent / + | Zooms the timeline from 50% to 150% in steps of 10%. The last value is kept the next time the panel opens |
| Language | The same language list X uses |
| Sun / moon switch | Day is on the left, night is on the right. The white knob covers the icon for the active side |

When the panel opens, the extension sets X’s interface to the browser language. If you are signed in, that updates the X account’s display language, including on other devices. A language you later pick in the menu is remembered and used the next time the panel opens.

The panel’s own text is available in Simplified Chinese, Traditional Chinese, and English. For any other language, X switches to that language and the panel text stays in English.

The day or night choice is remembered. Switching it changes the panel and the X page inside it together.

## Followers

Click **Followers**. The page title is “Following and followers”. It has three lists:

| List | Who is included |
| --- | --- |
| Not following back | Accounts you follow that did not follow you in the latest successful sync |
| Unfollowed | Accounts that were in a follower list and are absent from a later complete sync |
| Ignored | Accounts you hid yourself |

Each row shows the display name and `@handle` read during that sync. A row without a display name shows the `@handle`. The name opens that account’s X profile in a new tab.

### Sync now

After you are signed in, click **Sync now**. The panel scrolls your followers and following pages in the background and compares the lists on this computer. Sync uses the current X web session. It does not use a developer API quota and does not open a tab for you to watch. Keep the side panel open while it runs.

The same X account can start another sync only after **1 hour**:

- The hour starts only after both lists are read and saved. A failed or incomplete read does not start it, and the button can be used again immediately
- The button changes to a remaining time such as “60 min” and stays disabled
- Closing the panel and opening it again keeps the remaining time
- Clicking sync while signed out only asks you to sign in. That click does not start the hour

An account with no earlier sync can sync immediately. An account that already has a record can sync again one hour after the latest sync.

During a sync, the extension reads how many list requests X has left. When two or fewer remain, scrolling pauses until the reset time X returns, then continues the list that is already open.

If the follower list loads only in part, the people already read are saved, and new unfollows are not decided from that partial list. The unfollow list changes after a complete sync.

### Days, ignore, and the daily record

**Not following back for at least N days** applies only to “Not following back”. The count starts on the day a sync first finds that they do not follow you back, and runs through the latest successful sync. If a later sync finds that they follow you back, and a sync after that finds that they do not, the count starts over. Days use China Standard Time (UTC+8).

**Ignore** on a row removes that account from both “Not following back” and “Unfollowed” and places them under **Ignored**. **Stop ignoring** puts them back. The ignore list is stored on this computer for the current X account.

**Daily record (Beijing time)** stores the following count, follower count, and not-following-back count from each sync. Another sync on the same day updates that day’s numbers.

### How unfollows are decided

Unfollows are matched by X user ID, so a renamed account still matches. The first web sync only sets a baseline. It does not treat everyone absent from that first follower list as a new unfollow. If they follow you again later, they leave the unfollow list. Counts include only accounts that were actually read.

## Where the data stays

The follower snapshot, the not-following-back list, the unfollow list, the ignore list, and the daily counts are stored in Chrome on this computer, separately for each X account. The extension does not upload those lists to a server of its own. Signing in to a different X account shows that account’s own records.

## Risk

> This is a third-party tool and is not affiliated with X. To load X in the side panel, the extension changes embedding restrictions and some request headers. That can trigger account verification, feature limits, or suspension. **Account safety is not guaranteed.**
>
> Use the official X website or app for important accounts. If X asks you to verify the account or limits it, stop using this extension and follow X's instructions. See the [X Terms of Service](https://x.com/en/tos).
