# MYDON research dependency policy

Этот файл — локальная политика предварительного research-review, а не база CVE и не
разрешение на установку. `solution-scout` читает только ограниченные публичные README и
top-level manifests, поэтому любой автоматический вывод обязан иметь статус
`dependency/security advisory review incomplete; CVE не проверялись` до ручной
проверки lockfile, transitive dependencies, advisory, лицензии и условий API.

## Denylist

- `openclaw` — запрещён продуктовым решением MYDON. Наличие имени в реально полученных
  GitHub metadata, README или manifest даёт флаг `🛑` и ограничивает оценку готовности
  значением 2/5.

Нельзя добавлять сюда пакет как «уязвимый» без ссылки на проверяемый advisory и даты
проверки. Отсутствие совпадения с коротким denylist не означает, что проект безопасен.
