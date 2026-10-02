# The JDK the Java sandbox uses, with the Kotlin compiler (kotlinc) and its
# standard library under /opt/kotlinc. Programs are compiled to JVM classes and
# run, debugged and visualized by the same tooling as Java.
FROM eclipse-temurin:21-jdk
ARG KOTLIN_VERSION=2.2.20
RUN apt-get update && apt-get install -y --no-install-recommends unzip curl ca-certificates \
 && curl -fsSL -o /tmp/kotlinc.zip "https://github.com/JetBrains/kotlin/releases/download/v${KOTLIN_VERSION}/kotlin-compiler-${KOTLIN_VERSION}.zip" \
 && unzip -q /tmp/kotlinc.zip -d /opt && rm /tmp/kotlinc.zip \
 && apt-get purge -y unzip curl && rm -rf /var/lib/apt/lists/*
ENV PATH="/opt/kotlinc/bin:${PATH}"
