# PHP with Xdebug, for the debugger and the visualizer. Xdebug is installed but
# not loaded: a debug run loads it with -d zend_extension=xdebug, so normal
# runs (which use php:8.4-cli-alpine itself) are untouched. Python runs the
# scripts that talk to Xdebug.
FROM php:8.4-cli-alpine
RUN apk add --no-cache python3 \
 && apk add --no-cache --virtual .build-deps $PHPIZE_DEPS linux-headers \
 && pecl install xdebug-3.4.5 \
 && apk del .build-deps \
 && rm -rf /tmp/pear
