import LoadingAnimation from "./LoadingAnimation";


export default function SwiperLoadingAnimation() {
    return (
        <div
            style={{
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                height: '100%',
                width: '100%',
                position: 'relative',
            }}
        >
            <div
                style={{
                    display: 'flex',
                    justifyContent: 'center',
                    alignItems: 'center',
                    position: 'absolute',
                    width: 310, // Set a fixed width
                    height: 330, // Set a fixed height
                }}
            >
                <LoadingAnimation />
            </div>
        </div>
    );
}
