---
cover: https://remote.example/cover.png
subtitle: Every way a page can reference the network
---

# Remote references

![md image](https://remote.example/a.png)

![ref image][ref]

[ref]: https://remote.example/ref.png

<img src="https://remote.example/c.png" srcset="https://remote.example/c2.png 2x">

<picture><source srcset="https://remote.example/i.png"><img src="https://remote.example/j.png"></picture>

<audio src="https://remote.example/d.mp3" controls></audio>

<video src="https://remote.example/e.mp4" poster="https://remote.example/poster.png" controls></video>

<video controls><source src="https://remote.example/f.webm"></video>

<span style="background:url(https://remote.example/g.png)">styled span</span>

<div data-bg="url(https://remote.example/h.png)">css-looking attribute</div>

<link rel="stylesheet" href="https://remote.example/k.css">

<iframe src="https://remote.example/l.html"></iframe>

<object data="https://remote.example/m.swf"></object>

<svg><image href="https://remote.example/n.png"></image></svg>

<form action="https://remote.example/o"><button>send</button></form>

[a plain link](https://remote.example/p) and an autolink <https://remote.example/q>

> [!note] Callout
> ![in a callout](https://remote.example/r.png)

::::columns
:::column
![left](https://remote.example/s.png)
:::
:::column
![[https://remote.example/t.png]]
:::
::::

| a                                     | b   |
| ------------------------------------- | --- |
| ![cell](https://remote.example/u.png) | x   |

![[Other]]

![[Other#Section]]
