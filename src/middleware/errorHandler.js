/**
 * Global error handler middleware
 */
export function errorHandler(err, req, res, next) {
  console.error('Error:', err);

  // Default error
  let statusCode = 500;
  let message = 'Internal server error';

  // Handle known error types
  if (err.message) {
    message = err.message;
  }

  if (err.statusCode) {
    statusCode = err.statusCode;
  }

  // A driver error is not an explanation. Adding the same card to a deck twice
  // used to answer with "UNIQUE constraint failed: deck_cards.deck_id,
  // deck_cards.printing_id, deck_cards.is_sideboard, deck_cards.is_foil" —
  // which tells the person nothing they can act on and tells everyone else the
  // shape of the schema. The full error is still logged above; only what goes
  // over the wire is replaced.
  if (typeof err.code === 'string' && err.code.startsWith('SQLITE_')) {
    const isConstraint = err.code.startsWith('SQLITE_CONSTRAINT');
    statusCode = err.statusCode || (isConstraint ? 409 : 500);
    message = isConstraint
      ? 'That change conflicts with something already saved'
      : 'Internal server error';
  }

  // Send error response
  res.status(statusCode).json({
    error: message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
}

/**
 * 404 handler
 */
export function notFoundHandler(req, res) {
  res.status(404).json({ error: 'Route not found' });
}
