---
subtitle: "A desert world with one deep well, two moons, and a year of 351 days."
icon: 🪐
cover: /attachments/covers/kessari.jpg
cover-y: 60
tags: [world, astronomy]
related:
  - { link: "[[Ilu]]", label: "moon", directed: true }
  - { link: "[[Thane]]", label: "moon", directed: true }
  - "[[Well of Osk]]"
  - "[[Timeline]]"
---

# Kessari

Kessari is a dry world circling a hot yellow sun. Most of its surface is sand: long dune seas called *ergs*, salt pans that glitter like snow, and the strange plain of fused glass where [[Glassreach]] stands. It has not rained in the lowlands in living memory. What water there is lies deep under the rock, and it moves with the moons.

| | |
|---|---|
| **Moons** | Two: [[Ilu]] (large, pale, slow) and [[Thane]] (small, red, fast) |
| **Year** | 351 days, thirteen turns of Ilu |
| **Closings** | 26 a year, alternately at dusk and at dawn |
| **Water** | Counted in drams; one dram is, by old custom, a day's drinking for a grown adult[^dram] |
| **Deep wells** | One: the [[Well of Osk]] |
| **Rain** | Not in the lowlands, not in living memory |
| **Dating** | Years of the Well (YW), from the year the first water was drawn. *The Story* takes place in 413. |

## The two moons

Ilu goes once round Kessari in $T_{\text{Ilu}} = 27$ days. Thane, much closer in, goes round in $T_{\text{Thane}} = 9$, exactly three times as fast. Because both move the same way round the sky, Thane keeps overtaking Ilu, and the time between one overtaking and the next, when the two moons rise together, is the **synodic period** $S$:

$$
\begin{aligned}
\frac{1}{S} &= \frac{1}{T_{\text{Thane}}} - \frac{1}{T_{\text{Ilu}}} = \frac{1}{9} - \frac{1}{27} = \frac{2}{27} \\[6pt]
S &= \frac{27}{2} = 13.5 \ \text{days}
\end{aligned}
$$

So the moons meet twice in every turn of Ilu. That is a **Closing**.

Because $S$ is thirteen days *and a half*, each Closing falls half a day later in the daily round than the one before: one comes at dusk, the next at dawn, the next at dusk again. The **Dusk Closing**, every $2S = 27$ days, is the long one: the moons rise together at nightfall, the deep water rises through the dark, and the dunes sing for most of the night. The **Dawn Closing** is short and quiet, and happens mostly in daylight.

```mermaid
flowchart LR
    Dusk(["Dusk Closing: long, the dunes sing"]) -->|"13.5 days"| Dawn(["Dawn Closing: short and quiet"])
    Dawn -->|"13.5 days"| Dusk
```

The year works out evenly too. Thirteen turns of Ilu make $Y = 13 \times 27 = 351$ days, which holds exactly $Y / S = 26$ Closings and $Y / T_{\text{Thane}} = 39$ turns of Thane. The Keepers number the Closings of each year from 1 to 26, and the odd ones are always the Dusk Closings.

> [!note] Why the water rises
> A moon's pull on the deep water, the part that raises a tide, falls off with the cube of its distance, $F \propto M / d^{3}$. Thane is small but close; Ilu is large but far; on Kessari their pulls are roughly equal. When they line up, the pulls add, $F_{\text{Closing}} \approx F_{\text{Ilu}} + F_{\text{Thane}}$, and the water in the deep rock rises up the shaft of the [[Well of Osk]] like a slow breath. When the moons stand a quarter of the sky apart, the pulls work against each other and the water lies at its lowest. (**Low moon**, when both moons are below the horizon, is something else: simply the hour at which the Courts sit, so that no house can say the moons favoured it.)

## The singing dunes

At every Closing, the great dunes of [[The Singing Erg]] give out a deep, steady hum that can be heard, and felt, a day's walk away. The drovers say the dunes are calling the water up. The Wellwrights say the rising water shifts the sand from below, and the sand, sliding, sings.[^song] In [[Glassreach]] the spires take up the note and ring with it. You can hear an imitation in [[The Dunes at Dusk]].

## Living with the dry

- **Dew.** On the shaded side of glass walls, a little dew forms before dawn. In the poorer quarters of Glassreach it is scraped off and drunk, a chore usually given to children.
- **Linen, not paper.** Paper cracks within a season in the dry; parchment curls; linen lasts for centuries if it is aired. Hence [[The Linen-Keepers]].
- **Cairns, not roads.** Roads are buried in a week. The [[The Salt Road|Salt Road]] is a line of cairns, reset by every caravan that passes.

[^dram]: The Courts' brass dram-cups are kept in the [[The Salt Courts|Terraces]] as the standard. A working drover needs about two drams a day in the deep desert; a scholar, the drovers say, about a third of one.
[^song]: Both are probably right. Singing sand needs very dry, very round grains sliding over one another in a steady avalanche; something has to start the avalanche.
