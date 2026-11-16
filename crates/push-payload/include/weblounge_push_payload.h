#ifndef WEBLOUNGE_PUSH_PAYLOAD_H
#define WEBLOUNGE_PUSH_PAYLOAD_H

#include <stddef.h>
#include <stdint.h>

/* Bytes lent for one call; data may be NULL only when len is 0, and len is at most PTRDIFF_MAX.
 * An internal error aborts the process rather than returning. */
typedef struct {
  const uint8_t *data;
  size_t len;
} WebloungeBytes;

/* Returns the prepare_notification JSON, or NULL for a NULL pointer or non-UTF-8 string.
 * Release the result with weblounge_string_free. */
char *weblounge_prepare_notification(WebloungeBytes ciphertext,
                                     WebloungeBytes private_key_pkcs8,
                                     WebloungeBytes auth,
                                     const char *network_label,
                                     const char *nickname);

/* Returns body with the unread-count line, or NULL for a NULL pointer or non-UTF-8 string.
 * Release the result with weblounge_string_free. */
char *weblounge_counted_notification_body(const char *body,
                                          uint32_t count,
                                          const char *new_messages);

/* Releases a string this library returned; NULL is ignored. */
void weblounge_string_free(char *value);

#endif
