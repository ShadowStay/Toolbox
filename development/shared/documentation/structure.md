# Development Structure Documentation

This document describes the shared components and development structure for Iprix's Spells.

## Shared Components Directory Structure

```
shared/
├── components/          # Reusable UI components
│   ├── navigation/      # Navigation-related components  
│   ├── forms/           # Form input components
│   ├── cards/           # Data display cards
│   └── dialogs/         # Modal and dialog components
├── utilities/           # Shared JavaScript utilities
│   ├── helpers.js       # General helper functions
│   ├── storage.js       # Storage-related utilities  
│   └── validation.js    # Input validation functions
├── styles/              # CSS shared components and variables
│   ├── variables.css    # CSS variables and theme definitions
│   ├── mixins.css       # CSS mixins for common patterns  
│   └── base.css         # Base styles and resets
└── documentation/       # Architecture and API documentation  
    ├── api.md           # API specifications
    ├── architecture.md  # System architecture documentation
    └── contributing.md  # Contribution guidelines
```

## Key Principles

1. **Reusability**: Components should be designed to be used across multiple tools
2. **Modularity**: Each component should have a single, well-defined responsibility  
3. **Consistency**: Follow established naming conventions and patterns
4. **Lightweight**: Minimize dependencies between components

## Development Workflow

When implementing new features:
1. Check if existing shared components can be reused
2. If not, create new shared components in appropriate directories
3. Implement new features in phase-specific directories  
4. Ensure compatibility with main application code
5. Test integration thoroughly

## Testing Guidelines

All shared components should include unit tests and integration tests where appropriate.