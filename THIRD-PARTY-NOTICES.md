# Third-party notices — FlickFetch 2.1

**Original FlickFetch application UI and integration code:** Copyright © 2026 Jessie Albert Regualos. This attribution does not claim ownership of separately licensed third-party software, libraries, platform content, trademarks, or APIs.

The following notices identify primary dependencies and runtime tools. They do not replace reviewing the license files for the exact versions and transitive dependencies included in a release.

## React and React DOM

React and React DOM are developed by Meta Open Source and distributed under the MIT License. Source and license: https://github.com/facebook/react

## Electron

Electron is an open-source desktop application framework. Review the license files and third-party notices in the exact Electron distribution. Source: https://github.com/electron/electron

## Tailwind CSS and Vite

Tailwind CSS and Vite are distributed under the MIT License. Sources: https://github.com/tailwindlabs/tailwindcss and https://github.com/vitejs/vite

## Lucide React

Lucide React icons are distributed under the ISC License. Source: https://github.com/lucide-icons/lucide

## ADM-ZIP

ADM-ZIP is a JavaScript ZIP archive library distributed under the MIT License. Source: https://github.com/cthackers/adm-zip

## yt-dlp

FlickFetch invokes the standalone yt-dlp executable to extract and download media from supported sites. yt-dlp is a third-party project and is distributed under the license stated in its upstream `LICENSE` and `THIRD_PARTY_LICENSES.txt`. FlickFetch's Windows x64 installer downloads the upstream release executable and verifies its SHA-256 against the official release checksum list before installation. Review the exact corresponding-source and notice requirements for the executable being installed.

## FFmpeg and FFprobe

FlickFetch's Windows x64 helper-tool installer downloads an FFmpeg build from the yt-dlp FFmpeg-Builds project. The selected `win64-gpl` asset is GPL-licensed and may include libraries with separate notices and corresponding-source obligations. Verify the exact build configuration, included external libraries, license texts, and corresponding-source compliance before redistribution.

## Deno

Deno is a JavaScript runtime that may be used by yt-dlp. Deno has its own license and third-party notices. Source: https://github.com/denoland/deno

## Spotify public playlist metadata

Spotify and its service are separate from FlickFetch. Spotify is a trademark of Spotify AB. Playlist matching reads metadata exposed by Spotify's public playlist embed page. It does not use the Spotify Web API, a Spotify Developer app, OAuth, or user credentials. The embed page is an unofficial surface and may change; private playlist data is not supported. FlickFetch provides YouTube match suggestions for review rather than automatically bulk-downloading songs from a Spotify playlist.

## Facebook and Instagram

Facebook and Instagram are separate services owned by Meta Platforms, Inc. FlickFetch is not affiliated with or endorsed by Meta. yt-dlp availability may depend on public accessibility, user login, cookies, account security checks, and changes to the platform.

## General

All third-party products, websites, media, names, logos, and trademarks belong to their respective owners. FlickFetch is an independent application and is not endorsed by supported websites. Before redistribution, read all exact license files included in the release and verify any corresponding-source and notice obligations. This file is informational and is not legal advice.
