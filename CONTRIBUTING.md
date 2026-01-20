# Contributing to Masumi Payment Service

We're happy you're interested in contributing! This document provides guidelines and instructions for contributing.

## Code of Conduct

- Be respectful
- Provide constructive feedback
- Focus on the best outcome for the project

## Getting Started

1. Fork the repository
2. Create a new branch for your feature/fix
3. Setup your development environment (see [Development Guide](docs/DEVELOPMENT.md))
4. Commit your changes
5. Create a pull request to the `dev` branch only

## Making Changes

### Security Considerations

As this project handles financial transactions:

- Always consider security implications
- Never commit sensitive data (keys, credentials)
- Follow secure coding practices
- When in doubt, ask for a security review

### Code Style

- Run `pnpm run lint` before committing
- Run `pnpm run format` to format code
- Follow TypeScript best practices
- Write clear, self-documenting code
- Add comments for complex logic

### Testing

- Add tests for new features
- Run `pnpm run test` to ensure all tests pass
- Aim for good test coverage
- Include both happy and error paths

### Pull Request Process

1. Update documentation for any changes
2. Ensure all tests pass
3. Update the changelog if applicable
4. Create a clear PR description explaining:
   - What changes you made
   - Why you made them
   - How to test them
   - Any breaking changes

## Review Process

1. At least one maintainer must review and approve
2. All automated checks must pass
3. Security-critical changes require additional review

## Getting Help

- Open an issue for questions
- Tag maintainers for urgent matters
- Join our community discussions
