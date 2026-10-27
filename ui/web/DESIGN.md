---
version: "alpha"
name: "FinTech Plataforma Financeira"
description: "Fintech landing, finance dashboard, charts, security, gold and dark palette, premium, trust, transactions, cards, modern UI. Ideal for landing pages, modern websites. AI-ready template."
colors:
  primary: "#FFD700"
  secondary: "#1A1A1A"
  tertiary: "#000000"
  neutral: "#FFFFFF"
  surface: "#C9A84C"
  accent: "#333333"
typography:
  h1:
    fontFamily: Inter
    fontSize: 2.5rem
    fontWeight: 700
  body-md:
    fontFamily: Inter
    fontSize: 1rem
    fontWeight: 400
rounded:
  sm: 8px
  md: 16px
  lg: 24px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.neutral}"
    rounded: "{rounded.sm}"
    padding: 12px
---

## Overview

Fintech landing, finance dashboard, charts, security, gold and dark palette, premium, trust, transactions, cards, modern UI. Ideal for landing pages, modern websites. AI-ready template. Before 2015, banking interfaces were hostile territory. Dense tables, cryptic transaction codes, layouts that screamed "we built this for mainframes and never looked back." Then Revolut, N26, and Nubank flipped the script. They understood something incumbents refused to see: money is emotional, and the interface should respect that.

The neobank revolution wasn't just about mobile-first. It was about treating the card as product — a physical artifact that extended the brand into wallets and Instagram posts. Nubank's purple card became a cultural symbol in Brazil. N26's transparent card whispered minimalism. Revolut's metal cards said "I'm in on this." The visual metaphor worked because it collapsed the distance between brand and daily life.

What followed was a design language shift across the entire finance vertical. Dark dashboards with glowing accent colors. Smooth transaction feeds that felt like social timelines. Charts that actually invited exploration instead of punishing curiosity. Fintech made finance feel approachable — not by dumbing it down, but by finally designing it for humans who carry phones, not briefcases.

- Density: 8/10 — Dense
- Variance: 4/10 — Moderate
- Motion: 4/10 — Subtle

- **Style:** Premium, Dark, Trustworthy
- **Keywords:** fintech landing, finance dashboard, charts, security, gold and dark palette, premium, trust, transactions, cards, modern UI
- **Era:** 2020s FinTech
- **Light/Dark:** ✗ No / ✓ Full

## Colors

- **Gold** (#FFD700) — Premium accent, decorative highlights
- **Dark Grey** (#1A1A1A) — Dark surface, primary background
- **Black** (#000000) — Dark surface, primary background
- **White** (#FFFFFF) — Secondary surface
- **Soft Gold** (#C9A84C) — Premium accent, decorative highlights
- **Charcoal** (#333333) — Deep contrast surface


## Typography

- **Display / Hero:** Inter — Weight 700, tight tracking, used for headline impact
- **Body:** Inter — Weight 400, 16px/1.6 line-height, max 72ch per line
- **UI Labels / Captions:** Inter — 0.875rem, weight 500, slight letter-spacing
- **Monospace:** JetBrains Mono — Used for code, metadata, and technical values

Scale:
- Hero: clamp(2.5rem, 5vw, 4rem)
- H1: 2.25rem
- H2: 1.5rem
- Body: 1rem / 1.6
- Small: 0.875rem


## Layout

- **Grid:** CSS Grid primary. Max-width containment: 1280px centered with 1.5rem side padding.
- **Spacing rhythm:** Balanced. Base unit: 0.5rem (8px).
- **Section vertical gaps:** clamp(4rem, 8vw, 8rem).
- **Hero layout:** Split-screen (text left, visual right).
- **Feature sections:** Zig-zag alternating text+image rows. No 3-equal-columns.
- **Mobile collapse:** All multi-column layouts collapse below 768px. No horizontal overflow.
- **z-index contract:** base (0) / sticky-nav (100) / overlay (200) / modal (300) / toast (500).


## Elevation & Depth

Fundo escuro com detalhes em dourado, gráficos minimalistas em SVG, hover com glow sutil (box-shadow), animações de números incrementais, cards com sombra e borda suave.

- **Physics:** Ease-out curves, 200-300ms duration. Smooth and predictable.
- **Entry animations:** Fade + translate-Y (16px → 0) over 420ms ease-out. Staggered cascades for lists: 80ms between items.
- **Hover states:** Subtle color shift + shadow adjustment over 200ms.
- **Page transitions:** Fade only (200ms).
- **Performance:** Only transform and opacity animated. No layout-triggering properties.


## Shapes

Base corner radius: 8px. See rounded tokens in front matter for the full scale.


## Components

- **Primary Button:** Rounded (8px) shape. Accent color fill. Hover: 8% darken + subtle lift shadow. Active: -1px translate tactile press. Font weight 600. No outer glows.
- **Secondary / Ghost Button:** Outline variant. 1.5px border in muted color. Text in primary color. Hover: subtle background fill.
- **Cards:** Rounded (8px) corners. Surface background. Subtle shadow (0 2px 12px rgba(0,0,0,0.06)). 1px border stroke.
- **Inputs:** Label above input. 1px border stroke. Focus ring: 2px accent color offset 2px. Error text below in semantic red. No floating labels.
- **Navigation:** Primary surface background. Active item: accent color indicator. Font weight 500 when active.
- **Skeletons:** Shimmer animation matching component dimensions. No circular spinners.
- **Empty States:** Icon-based composition with descriptive text and action button.


## Do's and Don'ts

- No emojis in UI — use icon system only (Lucide, Heroicons)
- No pure white (#FFFFFF) backgrounds — use off-white or dark surfaces
- No oversaturated accent colors (saturation cap: 80%)
- No 3-column equal-width feature layouts — use zig-zag or asymmetric grid
- No `h-screen` — use `min-h-[100dvh]`
- No AI copywriting clichés: "Elevate", "Seamless", "Unleash", "Next-Gen"
- No broken external image links — use picsum.photos or inline SVG
- No generic lorem ipsum in demos

- Do Navbar + Hero com números/benefícios
- Do Metrics + Security
- Do Testimonials + Pricing
- Do CTA 'Criar conta'
- Do Meta tags SEO
- Do Contraste texto/fundo escuro
- Do Animações de números
- Do Ícones SVG financeiros.


## Use Case

Landing pages, Modern websites

<!-- Source: https://designmd.app/library/fintech-plataforma-financeira · designmd.app -->
