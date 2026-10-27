'use strict';

module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/app/**/*.test.js'],
  collectCoverageFrom: ['src/**/*.js', 'api/**/*.js'],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'text-summary', 'lcov', 'json-summary'],
  // Jest's key is "coverageThreshold" (singular): the plural form is silently ignored.
  coverageThreshold: {
    global: { branches: 80, functions: 80, lines: 80, statements: 80 },
  },
  collectCoverage: true,
};
