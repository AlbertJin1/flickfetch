# Third-party notices — FlickFetch

**Original FlickFetch application UI and integration code:** Copyright © 2026 Jessie Albert Regualos. This attribution does not claim ownership of separately licensed third-party tools, libraries, platform content, or trademarks.

## yt-dlp

FlickFetch invokes the standalone yt-dlp executable to extract and download media from supported sites. yt-dlp is a third-party project and is distributed under the license stated in its own upstream `LICENSE` and `THIRD_PARTY_LICENSES.txt`. The release preparation script downloads the official Windows executable and attempts to bundle matching license and source materials; verify that the source materials correspond to the exact binary distributed.

## FFmpeg and FFprobe

The release build uses an FFmpeg Windows build from the yt-dlp FFmpeg-Builds project. The selected `win64-gpl` variant is GPL-licensed and may include libraries with separate notices and corresponding-source obligations. The release script collects upstream license texts, build/version details, and a source snapshot when available, but a redistributor must verify exact build configuration, external-library licenses, and completeness of source compliance before distribution.

## Deno

Deno is bundled as a JavaScript runtime that can be used by yt-dlp. Deno has its own license; the release script downloads its upstream license.

## Spotify public playlist metadata

Spotify and its service are separate from FlickFetch. Spotify is a trademark of Spotify AB. Playlist matching reads the metadata exposed by Spotify's public playlist embed page; it does not use the Spotify Web API, a Spotify Developer app, OAuth, or user credentials. The embed page format is unofficial and can change, and private playlist data is not supported. FlickFetch provides YouTube match suggestions for review rather than automatically bulk-downloading songs from a Spotify playlist. Only save content you own or are authorized to download, and follow the applicable source-service terms.

## Facebook and Instagram

Facebook and Instagram are separate services owned by Meta Platforms, Inc. FlickFetch is not affiliated with or endorsed by Meta. yt-dlp availability may depend on public accessibility, user login, cookies, account security checks, and changes to the platform.

## General

All third-party products, websites, media, names, logos and trademarks belong to their respective owners. FlickFetch is an independent application and is not endorsed by supported websites. Before redistribution, read all exact license files included in the release and verify any corresponding-source and notice obligations. This file is informational and is not legal advice.
## Avalonia UI and Inter font

FlickFetch uses the Avalonia UI framework, including the Desktop, Fluent theme, and Inter font packages. Avalonia source is available at https://github.com/AvaloniaUI/Avalonia and is distributed under the MIT License; consult upstream licensing materials for the exact dependency versions restored at build time. The Inter typeface is distributed under the SIL Open Font License; see https://github.com/rsms/inter/blob/master/LICENSE.txt. NuGet package metadata and upstream repositories should be checked when preparing a public redistribution.
