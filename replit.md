# EmeraldNetwork Website

## Overview

EmeraldNetwork is a static HTML website showcasing various applications and services created by IceEmerald. The site serves as a portfolio and landing page for multiple projects including Discord bots, Minecraft servers, and plugins. It features a modern, responsive design with smooth animations and interactive elements like dropdown navigation and custom right-click context menus.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture
- **Technology Stack**: Pure HTML5, CSS3, and vanilla JavaScript
- **Design Pattern**: Static multi-page application with shared components
- **Styling**: Custom CSS with Inter font family from Google Fonts, responsive design principles
- **Navigation**: Sticky header with dropdown menus and smooth scrolling between sections

### Page Structure
- **Main Pages**: 
  - `index.html` - Homepage with hero section and project showcase
  - `404.html` - Custom error page
  - `discordemeraldbot.html` - Discord bot landing page
  - `discordemeraldbotcmds.html` - Bot commands documentation
- **Shared Components**: Common header navigation, footer, and styling across all pages

### Interactive Features
- **Animation System**: Intersection Observer API for scroll-triggered animations (`animationvisible.js`)
- **Custom Scrolling**: Smooth scroll implementation with physics-based momentum (`scrollice.js`)
- **Dropdown Navigation**: Mouse-hover activated dropdown menus (`dropdown.js`)
- **Context Menu**: Custom right-click menu with copy functionality (`rightclick.js`)

### Asset Organization
- **Styles**: Centralized CSS in `/assets/styles/style.css`
- **Scripts**: Modular JavaScript files in `/assets/scripts/`
- **Images**: Static assets stored in `/assets/images/`

### Visual Design
- **Color Scheme**: Dark mode support with dynamic theming (dark backgrounds for bot pages)
- **Typography**: Inter font family for modern, clean appearance
- **Icons**: SVG icons for scalable, crisp graphics
- **Responsive Design**: Mobile-first approach with flexible layouts

## External Dependencies

### Third-Party Services
- **Google Fonts**: Inter font family for typography
- **Discord API**: Bot invitation links and Discord server integration

### Browser APIs
- **Intersection Observer**: For scroll-based animation triggers
- **Clipboard API**: For copy-to-clipboard functionality in context menu
- **History API**: For smooth scrolling navigation state management

### Development Tools
- **Semgrep**: Security scanning configuration for Bicep files (though not directly used in this HTML project)

### CDN Resources
- Google Fonts CDN for web font delivery
- Self-hosted static assets for images and icons