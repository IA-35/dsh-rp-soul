"""A minimal persona used by every engine test."""

PERSONA = {
    "id": "rain_clinic",
    "title": "雨夜诊所",
    "revision": "0123456789abcdef",
    "prose": "林晚是社区诊所的夜班医生。",
    "person": "second",
    "start": {"day": 1, "minute": 22 * 60},
    "mood_base": 55,
    "mood_thresholds": {"open": 72, "closed": 40, "break": 18},
    "places": [
        {"id": "clinic", "name": "诊所", "detail": "白炽灯下的诊室", "privacy": "private"},
        {"id": "hall", "name": "走廊", "privacy": "semi"},
    ],
    "cast": [
        {
            "id": "lin_wan",
            "name": "林晚",
            "call": "林医生",
            "gender": "female",
            "age": 31,
            "tier": "major",
            "role": "夜班医生",
            "adult_context": "社区诊所夜班医生，执夜三年",
            "appearance": "白大褂袖口卷到小臂",
            "voices": {"surface": "话少，句子短", "inner": "总在算时间"},
            "decision": {
                "core_value": "不欠人情",
                "pressure_responses": {
                    "low": "照常做事",
                    "mid": "开始沉默",
                    "high": "把话说绝",
                    "breaking": "直接离开诊室",
                },
            },
            "goal": {"kind": "observe", "text": "看{npc.name}今晚会不会留下来"},
            "situation": {"trigger": "雨还没停", "pressure": "值班表没人补", "exits": []},
            "schedule": [{"from": 0, "to": 1439, "location_id": "clinic"}],
        },
        {
            "id": "zhou_yi",
            "name": "周奕",
            "gender": "male",
            "age": 27,
            "tier": "supporting",
            "adult_context": "实习护士",
        },
    ],
}
